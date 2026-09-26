import { describe, it, expect } from "vitest";
import { summarize, percentile } from "@/server/deals/trust";

const NOW = new Date("2026-09-27T12:30:00Z");
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000).toISOString();
const deal = (status: string, amountUsd: number, createdMinAgo: number, settledMinAgo: number | null, extra: object = {}) => ({
  status, amountUsd, card: "microform", agent: null, createdAt: at(createdMinAgo),
  events: [{ at: at(createdMinAgo), status: "HELD" }, ...(settledMinAgo === null ? [] : [{ at: at(settledMinAgo), status }])], ...extra,
});

describe("Trust and Safety console numbers come only from the deal records", () => {
  const s = summarize([
    deal("REVERSED", 64, 30, 20, { verdict: { kind: "RECALL_MATCH", recall: "26061" } }),
    deal("REVERSED", 64, 50, 45, { verdict: { kind: "RECALL_MATCH", recall: "26061" } }),
    deal("REVERSED", 40, 90, 80, { verdict: { kind: "BANNED_TYPE", recall: null }, agent: "tap-key-1", card: "sandbox-test-card" }),
    deal("CAPTURED", 36, 20, 18),
    deal("HELD", 100, 5, null),
  ], NOW);

  it("totals money by outcome and keeps recalled or banned money separate", () => {
    expect(s.deals).toBe(5);
    expect(s.keptFromBadItemsUsd).toBe(168);
    expect(s.byStatus.CAPTURED).toEqual({ n: 1, usd: 36 });
    expect(s.byStatus.HELD.n).toBe(1);
  });
  it("groups reversals by the actual recall number or ban, most common first", () => {
    expect(s.reversalReasons[0]).toEqual({ reason: "CPSC recall 26061", recall: "26061", n: 2, usd: 128 });
    expect(s.reversalReasons[1]).toMatchObject({ reason: "Banned product type", n: 1 });
  });
  it("measures hold-to-decision time over settled deals only", () => {
    expect(s.decisionSeconds.n).toBe(4); // the open HELD deal is excluded
    expect(s.decisionSeconds.median).toBe(300); // 10, 5, 10, 2 min -> sorted 2, 5, 10, 10 -> p50 = 5 min
  });
  it("splits agent vs person checkouts and card sources, and buckets the last 24 hours", () => {
    expect(s.bySource).toEqual({ agent: 1, person: 4 });
    expect(s.byCard).toEqual({ microform: 4, "sandbox-test-card": 1 });
    expect(s.hourly).toHaveLength(24);
    expect(s.hourly.reduce((a, h) => a + h.n, 0)).toBe(5);
  });
  it("is safe on an empty store and on odd records", () => {
    const e = summarize([], NOW);
    expect(e.decisionSeconds.median).toBeNull();
    expect(e.keptFromBadItemsUsd).toBe(0);
    expect(summarize([{ status: "CAPTURED", amountUsd: 5, card: null, agent: null, createdAt: "garbage" }], NOW).decisionSeconds.n).toBe(0);
    expect(percentile([], 50)).toBeNull();
  });
});
