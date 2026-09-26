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

  it("an expired claim with no stored result is UNKNOWN: never a second Visa call, never a takeover", async () => {
    const store = memoryClaims<R>();
    let t = 1_000_000;
    store.docs.set("shs-4", { _id: "shs-4", by: "crashed", at: t, expiresAt: t + CLAIM_TTL_MS }); // never finished
    const calls: string[] = [];
    const now = () => t;
    const sleep = async (ms: number) => { t += ms; };
    // while it may still be running: waits (bounded), then busy
    expect(await settleOnce("shs-4", visaCall("CAPTURED", "early", calls), { store, claim: true, now, sleep, log: quiet })).toEqual({ kind: "busy" });
    t += CLAIM_TTL_MS;
    expect(await settleOnce("shs-4", visaCall("CAPTURED", "late", calls), { store, claim: true, now, sleep, log: quiet })).toEqual({ kind: "uncertain" });
    expect(await settleOnce("shs-4", visaCall("HELD", "no-money", calls), { store, claim: false, now, sleep, log: quiet })).toEqual({ kind: "uncertain" });
    expect(calls).toHaveLength(0);
    expect(store.docs.get("shs-4")?.by).toBe("crashed");
  });

  it("a scan that moves no money never takes the claim, so a later capture still can", async () => {
    const store = memoryClaims<R>();
    const calls: string[] = [];
    await settleOnce("shs-5", visaCall("HELD", "needs-check", calls, 0), { store, claim: false, log: quiet });
    expect(store.docs.has("shs-5")).toBe(false);
    const cap = await settleOnce("shs-5", visaCall("CAPTURED", "clean", calls, 0), { store, claim: true, log: quiet });
    expect(cap.kind).toBe("ran");
  });

  it("without a store (Atlas not configured): unavailable for every scan, and NO Visa call", async () => {
    const log = vi.fn();
    const calls: string[] = [];
    expect(await settleOnce("shs-6", visaCall("CAPTURED", "x", calls, 0), { store: null, claim: true, log })).toEqual({ kind: "unavailable" });
    expect(await settleOnce("shs-6", visaCall("HELD", "needs-check", calls, 0), { store: null, claim: false, log })).toEqual({ kind: "unavailable" });
    expect(calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/nothing sent to Visa/));
  });

  it("a deal the record already shows as final (a pre-claim settlement, the sweeper) is never settled again", async () => {
    const store = memoryClaims<R>();
    const calls: string[] = [];
    const finalStatus = async () => "CAPTURED";
    expect(await settleOnce("shs-10", visaCall("REVERSED", "legacy retry", calls, 0), { store, claim: true, finalStatus, log: quiet })).toEqual({ kind: "final", status: "CAPTURED" });
    expect(await settleOnce("shs-10", visaCall("HELD", "needs-check", calls, 0), { store, claim: false, finalStatus, log: quiet })).toEqual({ kind: "final", status: "CAPTURED" });
    expect(calls).toHaveLength(0);
    expect(store.docs.has("shs-10")).toBe(false);
  });

  it("a deal record that cannot be read: unavailable, NO Visa call", async () => {
    const store = memoryClaims<R>();
    const calls: string[] = [];
    const finalStatus = async (): Promise<string | null> => { throw new Error("record unreadable"); };
    expect(await settleOnce("shs-11", visaCall("CAPTURED", "x", calls, 0), { store, claim: true, finalStatus, log: quiet })).toEqual({ kind: "unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("a no-money scan never reports HELD over a settlement it can see: in flight is busy, finished is replayed", async () => {
    const store = memoryClaims<R>();
    let t = 9_000_000;
    const now = () => t;
    const sleep = async (ms: number) => { t += ms; };
    const calls: string[] = [];
    store.docs.set("shs-12", { _id: "shs-12", by: "capturing", at: t, expiresAt: t + CLAIM_TTL_MS });
    expect(await settleOnce("shs-12", visaCall("HELD", "needs-check", calls, 0), { store, claim: false, now, sleep, log: quiet })).toEqual({ kind: "busy" });
    store.docs.get("shs-12")!.result = { status: "CAPTURED", by: "capturing" };
    expect(await settleOnce("shs-12", visaCall("HELD", "needs-check", calls, 0), { store, claim: false, now, sleep, log: quiet }))
      .toEqual({ kind: "replayed", result: { status: "CAPTURED", by: "capturing" } });
    // and a scan that starts while a capture is in flight waits for it, then gets its answer
    const store2 = memoryClaims<R>();
    const [cap, hold] = await Promise.all([
      settleOnce("shs-13", visaCall("CAPTURED", "clean", calls, 40), { store: store2, claim: true, sleep: tick, log: quiet }),
      tick(5).then(() => settleOnce("shs-13", visaCall("HELD", "needs-check", calls, 0), { store: store2, claim: false, sleep: tick, log: quiet })),
    ]);
    expect(cap.kind).toBe("ran");
    expect(hold).toEqual({ kind: "replayed", result: { status: "CAPTURED", by: "clean" } });
    expect(calls).toEqual(["CAPTURED:clean"]);
  });

  it("a store that fails before the claim is taken: NO Visa call", async () => {
    const broken: ClaimStore<R> = { insert: async () => { throw new Error("Atlas down"); }, get: async () => null, finish: async () => false };
    const log = vi.fn();
    const calls: string[] = [];
    expect(await settleOnce("shs-7", visaCall("CAPTURED", "x", calls, 0), { store: broken, claim: true, log })).toEqual({ kind: "unavailable" });
    expect(calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Atlas down/));
  });

  it("the store is lost after Visa succeeded: this caller gets the real answer; a retry is busy, then UNKNOWN, with no second call", async () => {
    const store = memoryClaims<R>();
    store.finish = async () => { throw new Error("write lost"); };
    let t = 5_000_000;
    const now = () => t;
    const sleep = async (ms: number) => { t += ms; };
    const calls: string[] = [];
    const first = await settleOnce("shs-8", visaCall("CAPTURED", "first", calls, 0), { store, claim: true, now, sleep, log: quiet });
    expect(first).toEqual({ kind: "ran", result: { status: "CAPTURED", by: "first" } });
    expect(await settleOnce("shs-8", visaCall("REVERSED", "retry", calls, 0), { store, claim: true, now, sleep, log: quiet })).toEqual({ kind: "busy" });
    t += CLAIM_TTL_MS;
    expect(await settleOnce("shs-8", visaCall("REVERSED", "retry", calls, 0), { store, claim: true, now, sleep, log: quiet })).toEqual({ kind: "uncertain" });
    expect(calls).toEqual(["CAPTURED:first"]);
  });

  it("finish only stores on the claim this request owns, once", async () => {
    const store = memoryClaims<R>();
    store.docs.set("shs-9", { _id: "shs-9", by: "owner", at: 0, expiresAt: 1 });
    expect(await store.finish("shs-9", "someone-else", { status: "CAPTURED", by: "x" })).toBe(false);
    expect(await store.finish("shs-9", "owner", { status: "CAPTURED", by: "owner" })).toBe(true);
    expect(await store.finish("shs-9", "owner", { status: "REVERSED", by: "owner" })).toBe(false);
    expect(store.docs.get("shs-9")?.result).toEqual({ status: "CAPTURED", by: "owner" });
  });
});
