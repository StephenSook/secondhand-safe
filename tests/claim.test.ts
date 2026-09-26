import { describe, expect, it, vi } from "vitest";
import { CLAIM_TTL_MS, memoryClaims, settleOnce, type ClaimStore } from "@/server/deals/claim";

type R = { status: string; by: string };
const tick = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const quiet = () => {};

/** A stand-in for one Visa settlement call: counts calls and takes `ms` to answer. */
function visaCall(status: string, by: string, calls: string[], ms = 30) {
  return async (): Promise<R> => { calls.push(`${status}:${by}`); await tick(ms); return { status, by }; };
}

describe("one settlement per deal", () => {
  it("concurrent capture + capture: exactly one Visa call, both get the same answer", async () => {
    const store = memoryClaims<R>();
    const calls: string[] = [];
    const [a, b] = await Promise.all([
      settleOnce("shs-1", visaCall("CAPTURED", "a", calls), { store, claim: true, sleep: tick, log: quiet }),
      settleOnce("shs-1", visaCall("CAPTURED", "b", calls), { store, claim: true, sleep: tick, log: quiet }),
    ]);
    expect(calls).toHaveLength(1);
    expect([a.kind, b.kind].sort()).toEqual(["ran", "replayed"]);
    expect("result" in a && a.result).toEqual("result" in b && b.result);
  });

  it("concurrent capture + reversal: exactly one Visa call; the other request gets the winner's answer, not its own", async () => {
    const store = memoryClaims<R>();
    const calls: string[] = [];
    const [cap, rev] = await Promise.all([
      settleOnce("shs-2", visaCall("CAPTURED", "clean scan", calls), { store, claim: true, sleep: tick, log: quiet }),
      settleOnce("shs-2", visaCall("REVERSED", "recalled scan", calls), { store, claim: true, sleep: tick, log: quiet }),
    ]);
    expect(calls).toEqual(["CAPTURED:clean scan"]);
    expect(cap).toEqual({ kind: "ran", result: { status: "CAPTURED", by: "clean scan" } });
    expect(rev).toEqual({ kind: "replayed", result: { status: "CAPTURED", by: "clean scan" } });
  });

  it("a repeat after completion returns the stored result without calling Visa", async () => {
    const store = memoryClaims<R>();
    const calls: string[] = [];
    await settleOnce("shs-3", visaCall("REVERSED", "first", calls), { store, claim: true, log: quiet });
    const again = await settleOnce("shs-3", visaCall("CAPTURED", "second", calls), { store, claim: true, log: quiet });
    const noMoney = await settleOnce("shs-3", visaCall("HELD", "needs-check", calls), { store, claim: false, log: quiet });
    expect(calls).toEqual(["REVERSED:first"]);
    expect(again).toEqual({ kind: "replayed", result: { status: "REVERSED", by: "first" } });
    expect(noMoney).toEqual({ kind: "replayed", result: { status: "REVERSED", by: "first" } });
  });

  it("a claim whose holder died expires and is taken over, so a hold is never locked forever", async () => {
    const store = memoryClaims<R>();
    let t = 1_000_000;
    store.docs.set("shs-4", { _id: "shs-4", by: "crashed", at: t, expiresAt: t + CLAIM_TTL_MS }); // never finished
    const calls: string[] = [];
    // before expiry: waits (bounded), then says busy without calling Visa
    const now = () => t;
    const sleep = async (ms: number) => { t += ms; };
    const early = await settleOnce("shs-4", visaCall("CAPTURED", "early", calls), { store, claim: true, now, sleep, log: quiet });
    expect(early).toEqual({ kind: "busy" });
    expect(calls).toHaveLength(0);
    t += CLAIM_TTL_MS;
    const late = await settleOnce("shs-4", visaCall("CAPTURED", "late", calls), { store, claim: true, now, sleep, log: quiet });
    expect(late).toEqual({ kind: "ran", result: { status: "CAPTURED", by: "late" } });
    expect(calls).toEqual(["CAPTURED:late"]);
    expect(store.docs.get("shs-4")?.result).toEqual({ status: "CAPTURED", by: "late" });
  });

  it("a scan that moves no money never takes the claim, so a later capture still can", async () => {
    const store = memoryClaims<R>();
    const calls: string[] = [];
    await settleOnce("shs-5", visaCall("HELD", "needs-check", calls, 0), { store, claim: false, log: quiet });
    expect(store.docs.has("shs-5")).toBe(false);
    const cap = await settleOnce("shs-5", visaCall("CAPTURED", "clean", calls, 0), { store, claim: true, log: quiet });
    expect(cap.kind).toBe("ran");
  });

  it("without a store (Atlas not configured) it runs once and logs it: Visa stays the only guard", async () => {
    const log = vi.fn();
    const calls: string[] = [];
    const out = await settleOnce("shs-6", visaCall("CAPTURED", "x", calls, 0), { store: null, claim: true, log });
    expect(out.kind).toBe("unclaimed");
    expect(calls).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/without a claim/));
  });

  it("a store that fails before the claim runs the settlement once (never twice) and logs it", async () => {
    const broken: ClaimStore<R> = {
      insert: async () => { throw new Error("Atlas down"); }, get: async () => null, takeOver: async () => false, finish: async () => {},
    };
    const log = vi.fn();
    const calls: string[] = [];
    const out = await settleOnce("shs-7", visaCall("CAPTURED", "x", calls, 0), { store: broken, claim: true, log });
    expect(out.kind).toBe("unclaimed");
    expect(calls).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Atlas down/));
  });

  it("a failed result write never repeats the Visa call", async () => {
    const store = memoryClaims<R>();
    store.finish = async () => { throw new Error("write lost"); };
    const calls: string[] = [];
    const out = await settleOnce("shs-8", visaCall("CAPTURED", "x", calls, 0), { store, claim: true, log: quiet });
    expect(out.kind).toBe("ran");
    expect(calls).toHaveLength(1);
  });
});
