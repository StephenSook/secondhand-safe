import { describe, it, expect, vi } from "vitest";

/** The watch loop only QUEUES calls (flags first), then runs them once, after the loop, bounded by its time budget. */
const order: string[] = [];
const hits = [0, 1, 2, 3].map((i) => ({ dealId: `shs-${i}`, listing: "x", recallNumber: "26-100", title: "t", url: "u", reason: "r" }));
vi.mock("@/server/deals/store", () => ({
  watchedSales: async () => hits.map((h) => ({ _id: h.dealId, listing: "x" })),
  flagPostSaleRecall: async (id: string) => { order.push(`flag:${id}`); return true; },
}));
vi.mock("@/server/watch/recheck", () => ({ recheckSales: () => hits }));
vi.mock("@/server/watch/push", () => ({ notify: async () => ({ sent: 0, failed: 0, subs: 0 }) }));
const run = vi.fn(async (deadline: number) => { order.push("run"); return { started: 4, outcomes: [], timedOut: false, deadline }; });
vi.mock("@/server/call/trigger", () => ({
  queueRecallCall: async (id: string) => { order.push(`queue:${id}`); return true; },
  runPendingCalls: (deadline: number) => run(deadline),
}));

describe("cron watch with the recall call", () => {
  it("flags and queues every hit, then runs the calls once, within maxDuration", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-for-tests");
    const { GET, maxDuration } = await import("@/app/api/cron/watch/route");
    const t0 = Date.now();
    const res = await GET(new Request("http://x/api/cron/watch", { headers: { authorization: "Bearer cron-secret-for-tests" } }));
    const j = await res.json();
    expect(j.hits.map((h: { flagged: boolean; call: string }) => [h.flagged, h.call])).toEqual(Array(4).fill([true, "queued"]));
    expect(order.at(-1)).toBe("run");
    expect(order.filter((o) => o === "run")).toHaveLength(1);
    expect(order.indexOf("flag:shs-3")).toBeLessThan(order.indexOf("run"));
    const deadline = run.mock.calls[0][0];
    expect(deadline).toBeGreaterThan(t0);
    expect(deadline).toBeLessThanOrEqual(t0 + maxDuration * 1000);
    vi.unstubAllEnvs();
  });
});
