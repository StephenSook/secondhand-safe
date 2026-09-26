import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// the recall-watch cron with its store, matcher, push and chain calls mocked: which sales get their asset updated
vi.mock("@/server/deals/store", () => ({ watchedSales: vi.fn(), flagPostSaleRecall: vi.fn(), recordPassportAssetRecall: vi.fn() }));
vi.mock("@/server/watch/recheck", () => ({ recheckSales: vi.fn() }));
vi.mock("@/server/watch/push", () => ({ notify: vi.fn() }));
vi.mock("@/server/solana/core", () => ({ updatePassportStatus: vi.fn() }));
vi.mock("@/server/solana/mints", () => ({ reconcileMints: vi.fn() }));
import { watchedSales, flagPostSaleRecall, recordPassportAssetRecall } from "@/server/deals/store";
import { recheckSales } from "@/server/watch/recheck";
import { notify } from "@/server/watch/push";
import { updatePassportStatus } from "@/server/solana/core";
import { reconcileMints } from "@/server/solana/mints";
import { GET } from "@/app/api/cron/watch/route";

const TOKEN = ["cron", "test", String(Date.now())].join("-");
const run = () => GET(new Request("https://example.test/api/cron/watch", { headers: { authorization: `Bearer ${TOKEN}` } }));
const hit = (dealId: string, recallNumber = "26-777") => ({ dealId, listing: "x", recallNumber, title: "Sleeper recall", url: "https://cpsc.example/r", reason: "r" });
const asset = (n: number) => `Asset${String(n).repeat(28)}`;

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", TOKEN);
  vi.mocked(notify).mockResolvedValue({ sent: 0, failed: 0, subs: 0 } as never);
  vi.mocked(updatePassportStatus).mockResolvedValue({ ok: true, address: "A", signature: "S" });
  vi.mocked(recordPassportAssetRecall).mockResolvedValue(true);
  vi.mocked(reconcileMints).mockResolvedValue({ checked: 0, results: [], unavailable: false });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.restoreAllMocks(); });

describe("recall watch updates the on-chain passport", () => {
  it("a newly flagged sale with an asset is set to RECALLED_AFTER_SALE; one without an asset is left alone", async () => {
    vi.mocked(watchedSales).mockResolvedValue([
      { _id: "shs-aaaaaaaa-0001", listing: "x", passportAsset: asset(1) },
      { _id: "shs-aaaaaaaa-0002", listing: "x" },
    ] as never);
    vi.mocked(recheckSales).mockReturnValue([hit("shs-aaaaaaaa-0001"), hit("shs-aaaaaaaa-0002")]);
    vi.mocked(flagPostSaleRecall).mockResolvedValue(true);
    const j = await (await run()).json();
    expect(updatePassportStatus).toHaveBeenCalledTimes(1);
    expect(updatePassportStatus).toHaveBeenCalledWith(asset(1), "RECALLED_AFTER_SALE", { recall: "26-777" });
    expect(recordPassportAssetRecall).toHaveBeenCalledWith("shs-aaaaaaaa-0001", asset(1), "26-777");
    expect(j.passportAssets).toEqual([{ dealId: "shs-aaaaaaaa-0001", asset: asset(1), recall: "26-777", updated: true, signature: "S", recorded: true }]);
    expect(reconcileMints).toHaveBeenCalledTimes(1);
  });
  it("a hit that was not flagged (push failed outright) does not touch the chain", async () => {
    vi.mocked(watchedSales).mockResolvedValue([{ _id: "shs-aaaaaaaa-0003", listing: "x", passportAsset: asset(3) }] as never);
    vi.mocked(recheckSales).mockReturnValue([hit("shs-aaaaaaaa-0003")]);
    vi.mocked(notify).mockResolvedValue({ sent: 0, failed: 1, subs: 1 } as never);
    await run();
    expect(flagPostSaleRecall).not.toHaveBeenCalled();
    expect(updatePassportStatus).not.toHaveBeenCalled();
  });
  it("an earlier flag whose chain update did not land is retried; one whose recall is confirmed is not", async () => {
    vi.mocked(watchedSales).mockResolvedValue([
      { _id: "shs-aaaaaaaa-0004", listing: "x", passportAsset: asset(4), postSaleRecall: { recallNumber: "26-100" }, passportAssetRecall: null },
      { _id: "shs-aaaaaaaa-0005", listing: "x", passportAsset: asset(5), postSaleRecall: { recallNumber: "26-100" }, passportAssetRecall: "26-100" },
    ] as never);
    vi.mocked(recheckSales).mockReturnValue([]);
    vi.mocked(updatePassportStatus).mockResolvedValue({ ok: false, reason: "not written: timeout" });
    const j = await (await run()).json();
    expect(updatePassportStatus).toHaveBeenCalledTimes(1);
    expect(updatePassportStatus).toHaveBeenCalledWith(asset(4), "RECALLED_AFTER_SALE", { recall: "26-100" });
    expect(recordPassportAssetRecall).not.toHaveBeenCalled();
    expect(j.passportAssets[0]).toMatchObject({ updated: false, reason: "not written: timeout" });
  });
  it("a second recall number: an asset already updated for recall R1 is updated again when the sale matches R2", async () => {
    vi.mocked(watchedSales).mockResolvedValue([
      { _id: "shs-aaaaaaaa-0006", listing: "x", passportAsset: asset(6), postSaleRecall: { recallNumber: "26-100" }, passportAssetStatus: "RECALLED_AFTER_SALE", passportAssetRecall: "26-100" },
    ] as never);
    vi.mocked(recheckSales).mockReturnValue([hit("shs-aaaaaaaa-0006", "26-200")]);
    vi.mocked(flagPostSaleRecall).mockResolvedValue(true);
    await run();
    expect(updatePassportStatus).toHaveBeenCalledWith(asset(6), "RECALLED_AFTER_SALE", { recall: "26-200" });
    expect(recordPassportAssetRecall).toHaveBeenCalledWith("shs-aaaaaaaa-0006", asset(6), "26-200");
  });
  it("at most three chain updates per run, one at a time; the rest are deferred to the next run", async () => {
    vi.mocked(watchedSales).mockResolvedValue([1, 2, 3, 4, 5].map((n) =>
      ({ _id: `shs-bbbbbbbb-000${n}`, listing: "x", passportAsset: asset(n), postSaleRecall: { recallNumber: "26-300" } })) as never);
    vi.mocked(recheckSales).mockReturnValue([]);
    let inFlight = 0, peak = 0;
    vi.mocked(updatePassportStatus).mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((ok) => setTimeout(ok, 5));
      inFlight--;
      return { ok: true, address: "A", signature: "S" };
    });
    const j = await (await run()).json();
    expect(updatePassportStatus).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
    expect(j.passportAssets.filter((p: { deferred?: boolean }) => p.deferred)).toHaveLength(2);
  });
  it("near the deadline the cron starts no new chain work (updates and mint reconciles are deferred)", async () => {
    const t0 = Date.parse("2026-09-26T13:37:00Z");
    let calls = 0;
    // the route reads the clock once at the start; every later read is 211 s in, with 89 s of the 300 s budget left
    vi.spyOn(Date, "now").mockImplementation(() => (calls++ === 0 ? t0 : t0 + 211_000));
    vi.mocked(watchedSales).mockResolvedValue([
      { _id: "shs-cccccccc-0001", listing: "x", passportAsset: asset(7), postSaleRecall: { recallNumber: "26-400" } },
    ] as never);
    vi.mocked(recheckSales).mockReturnValue([]);
    const j = await (await run()).json();
    expect(updatePassportStatus).not.toHaveBeenCalled();
    expect(j.passportAssets).toEqual([{ dealId: "shs-cccccccc-0001", asset: asset(7), recall: "26-400", deferred: true }]);
    const gate = vi.mocked(reconcileMints).mock.calls[0][0]?.canStartChainWork;
    expect(gate?.()).toBe(false);
  });
  it("with time left the same gate lets chain work start", async () => {
    vi.mocked(watchedSales).mockResolvedValue([] as never);
    vi.mocked(recheckSales).mockReturnValue([]);
    await run();
    expect(vi.mocked(reconcileMints).mock.calls[0][0]?.canStartChainWork?.()).toBe(true);
  });
});
