import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// the recall-watch cron with its store, matcher, push and chain calls mocked: which sales get their asset updated
vi.mock("@/server/deals/store", () => ({ watchedSales: vi.fn(), flagPostSaleRecall: vi.fn(), recordPassportAssetStatus: vi.fn() }));
vi.mock("@/server/watch/recheck", () => ({ recheckSales: vi.fn() }));
vi.mock("@/server/watch/push", () => ({ notify: vi.fn() }));
vi.mock("@/server/solana/core", () => ({ updatePassportStatus: vi.fn() }));
import { watchedSales, flagPostSaleRecall, recordPassportAssetStatus } from "@/server/deals/store";
import { recheckSales } from "@/server/watch/recheck";
import { notify } from "@/server/watch/push";
import { updatePassportStatus } from "@/server/solana/core";
import { GET } from "@/app/api/cron/watch/route";

const TOKEN = ["cron", "test", String(Date.now())].join("-");
const run = () => GET(new Request("https://example.test/api/cron/watch", { headers: { authorization: `Bearer ${TOKEN}` } }));
const hit = (dealId: string) => ({ dealId, listing: "x", recallNumber: "26-777", title: "Sleeper recall", url: "https://cpsc.example/r", reason: "r" });

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", TOKEN);
  vi.mocked(notify).mockResolvedValue({ sent: 0, failed: 0, subs: 0 } as never);
  vi.mocked(updatePassportStatus).mockResolvedValue({ ok: true, address: "A", signature: "S" });
  vi.mocked(recordPassportAssetStatus).mockResolvedValue(true);
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("recall watch updates the on-chain passport", () => {
  it("a newly flagged sale with an asset is set to RECALLED_AFTER_SALE; one without an asset is left alone", async () => {
    vi.mocked(watchedSales).mockResolvedValue([
      { _id: "shs-aaaaaaaa-0001", listing: "x", passportAsset: "Asset1111111111111111111111111111" },
      { _id: "shs-aaaaaaaa-0002", listing: "x" },
    ] as never);
    vi.mocked(recheckSales).mockReturnValue([hit("shs-aaaaaaaa-0001"), hit("shs-aaaaaaaa-0002")]);
    vi.mocked(flagPostSaleRecall).mockResolvedValue(true);
    const j = await (await run()).json();
    expect(updatePassportStatus).toHaveBeenCalledTimes(1);
    expect(updatePassportStatus).toHaveBeenCalledWith("Asset1111111111111111111111111111", "RECALLED_AFTER_SALE", { recall: "26-777" });
    expect(recordPassportAssetStatus).toHaveBeenCalledWith("shs-aaaaaaaa-0001", "RECALLED_AFTER_SALE");
    expect(j.passportAssets).toEqual([{ dealId: "shs-aaaaaaaa-0001", asset: "Asset1111111111111111111111111111", updated: true, signature: "S" }]);
  });
  it("a hit that was not flagged (push failed outright) does not touch the chain", async () => {
    vi.mocked(watchedSales).mockResolvedValue([{ _id: "shs-aaaaaaaa-0003", listing: "x", passportAsset: "Asset3333333333333333333333333333" }] as never);
    vi.mocked(recheckSales).mockReturnValue([hit("shs-aaaaaaaa-0003")]);
    vi.mocked(notify).mockResolvedValue({ sent: 0, failed: 1, subs: 1 } as never);
    await run();
    expect(flagPostSaleRecall).not.toHaveBeenCalled();
    expect(updatePassportStatus).not.toHaveBeenCalled();
  });
  it("an earlier flag whose chain update did not land is retried; a confirmed one is not", async () => {
    vi.mocked(watchedSales).mockResolvedValue([
      { _id: "shs-aaaaaaaa-0004", listing: "x", passportAsset: "Asset4444444444444444444444444444", postSaleRecall: { recallNumber: "26-100" }, passportAssetStatus: "CAPTURED" },
      { _id: "shs-aaaaaaaa-0005", listing: "x", passportAsset: "Asset5555555555555555555555555555", postSaleRecall: { recallNumber: "26-100" }, passportAssetStatus: "RECALLED_AFTER_SALE" },
    ] as never);
    vi.mocked(recheckSales).mockReturnValue([]);
    vi.mocked(updatePassportStatus).mockResolvedValue({ ok: false, reason: "not written: timeout" });
    const j = await (await run()).json();
    expect(updatePassportStatus).toHaveBeenCalledTimes(1);
    expect(updatePassportStatus).toHaveBeenCalledWith("Asset4444444444444444444444444444", "RECALLED_AFTER_SALE", { recall: "26-100" });
    expect(recordPassportAssetStatus).not.toHaveBeenCalled();
    expect(j.passportAssets[0]).toMatchObject({ updated: false, reason: "not written: timeout" });
  });
});
