import { describe, it, expect, afterEach, vi } from "vitest";
import { planSweep, sweepOutcome, runSweep, HOLD_WINDOW_HOURS, type HeldDeal } from "@/server/deals/sweep";
import { TTL_MS } from "@/server/deals/token";
import { GET } from "@/app/api/cron/sweep/route";
import type { VisaResult } from "@/server/visa/acceptance";
import { pub } from "@/server/deals/store";

const NOW = new Date("2026-09-27T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const deal = (id: string, h: number, authId?: string): HeldDeal => ({ _id: id, amountUsd: 64, createdAt: hoursAgo(h), authId });
const visa = (p: Partial<VisaResult>): VisaResult => ({ ok: false, status: "", httpStatus: 0, parsed: false, raw: null, ...p });
const creds = { merchantId: "m", keyId: "k", secret: "c2VjcmV0", host: "apitest.cybersource.com" };
// built at runtime so no secret-shaped literal sits in source (gitleaks generic-api-key)
const TEST_BEARER = ["unit", "test", "only", "not", "a", "credential"].join("-");

describe("hold sweeper plan", () => {
  it("only touches holds older than the window; reverses those with an authorization id, lapses the rest", () => {
    const plan = planSweep([deal("fresh", 2, "a1"), deal("old", 30, "a2"), deal("legacy", 40), deal("edge", 23.9, "a3"), { ...deal("bad-date", 99, "a4"), createdAt: "not a date" }], NOW, 24);
    expect(plan).toEqual([
      { action: "reverse", dealId: "old", amountUsd: 64, authId: "a2" },
      { action: "lapse", dealId: "legacy", amountUsd: 64 },
    ]);
  });

  it("maps Visa's answer: confirmed = RELEASED, a readable 4xx = REFUSED, anything else = UNKNOWN (stays held)", () => {
    expect(sweepOutcome("d", visa({ ok: true, status: "REVERSED", httpStatus: 201, parsed: true })).status).toBe("RELEASED");
    expect(sweepOutcome("d", visa({ status: "INVALID_REQUEST", reason: "MISSING_AUTH", httpStatus: 400, parsed: true })).status).toBe("REFUSED");
    expect(sweepOutcome("d", visa({ httpStatus: 502 })).status).toBe("UNKNOWN");
    expect(sweepOutcome("d", visa({ httpStatus: 0 })).status).toBe("UNKNOWN");
    expect(sweepOutcome("d", visa({ ok: true, httpStatus: 201, parsed: true })).note).not.toMatch(/\bsafe\b/i);
  });

  it("reverses the full held amount at Visa and never calls Visa for a lapsed legacy hold", async () => {
    const f = vi.fn(async () => Response.json({ id: "rev1", status: "REVERSED" }, { status: 201 }));
    const recorded: string[] = [];
    const out = await runSweep(creds, [{ action: "reverse", dealId: "old", amountUsd: 64, authId: "a2" }, { action: "lapse", dealId: "legacy", amountUsd: 64 }],
      { f: f as unknown as typeof fetch, record: async (o) => { recorded.push(`${o.dealId}:${o.status}:${f.mock.calls.length}`); } });
    // each outcome is recorded right after its own Visa call (a timeout can never strand an unrecorded reversal)
    expect(recorded).toEqual(["old:RELEASED:1", "legacy:LAPSED:1"]);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/pts/v2/payments/a2/reversals");
    expect(JSON.parse(String(init.body)).reversalInformation.amountDetails.totalAmount).toBe("64.00");
    expect(out.map((o) => o.status)).toEqual(["RELEASED", "LAPSED"]);
  });
});

describe("hold sweeper never loses track of a reversal", () => {
  it("stamps each deal BEFORE its Visa call", async () => {
    const order: string[] = [];
    const f = vi.fn(async () => { order.push("visa"); return Response.json({ id: "r", status: "REVERSED" }, { status: 201 }); });
    await runSweep(creds, [{ action: "reverse", dealId: "a", amountUsd: 1, authId: "x" }],
      { f: f as unknown as typeof fetch, stamp: async () => { order.push("stamp"); }, record: async () => { order.push("record"); } });
    expect(order).toEqual(["stamp", "visa", "record"]);
  });
  it("a previously attempted hold that Visa calls not open is labelled as probably released, not 'nothing to release'", () => {
    const r = visa({ status: "INVALID_REQUEST", reason: "MISSING_AUTH", httpStatus: 400, parsed: true });
    expect(sweepOutcome("d", r, true).note).toMatch(/earlier sweep attempt most likely released it/);
    expect(sweepOutcome("d", r, false).note).toMatch(/nothing to release/);
    const plan = planSweep([{ ...deal("old", 30, "a2"), sweepAttemptAt: hoursAgo(20) }], NOW, 24);
    expect(plan[0]).toMatchObject({ action: "reverse", attempted: true });
  });
});

describe("hold sweeper limits", () => {
  it("never sweeps a hold the buyer can still settle: the window is at least the pickup token's life", () => {
    expect(HOLD_WINDOW_HOURS * 3_600_000).toBeGreaterThan(TTL_MS);
  });
  it("starts no new reversal after the deadline", async () => {
    const f = vi.fn(async () => Response.json({ id: "r", status: "REVERSED" }, { status: 201 }));
    const out = await runSweep(creds, [{ action: "reverse", dealId: "a", amountUsd: 1, authId: "x" }], { f: f as unknown as typeof fetch, deadline: Date.now() - 1 });
    expect(out).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("the cron endpoint", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is off (503) without CRON_SECRET and refuses a wrong or missing bearer (401) before touching Visa or Atlas", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(new Request("http://x/api/cron/sweep"))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", TEST_BEARER);
    expect((await GET(new Request("http://x/api/cron/sweep"))).status).toBe(401);
    expect((await GET(new Request("http://x/api/cron/sweep", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    expect((await GET(new Request("http://x/api/cron/sweep", { headers: { authorization: TEST_BEARER } }))).status).toBe(401);
  });
});

describe("the stored Visa authorization id stays server-side", () => {
  it("is never in the public deal (board, seller view)", () => {
    const d = pub({ _id: "shs-1", listing: "t", amountUsd: 1, status: "HELD", card: null, agent: null, authId: "7612345678901234567890",
      createdAt: "x", updatedAt: "x", events: [] });
    expect(d).not.toHaveProperty("authId");
    expect(JSON.stringify(d)).not.toContain("7612345678901234567890");
    expect(d.dealId).toBe("shs-1");
  });
});
