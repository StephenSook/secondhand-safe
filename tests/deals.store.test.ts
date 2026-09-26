import { describe, it, expect, afterEach, vi } from "vitest";
import { recordHold, recordSettlement, getDeal, board } from "@/server/deals/store";
import { GET as dealGet } from "@/app/api/deals/[id]/route";
import { GET as qrGet } from "@/app/api/qr/route";

describe("deal store without a database degrades, never throws", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("writes report false and reads report 'unavailable' when MONGODB_URI is unset", async () => {
    vi.stubEnv("MONGODB_URI", "");
    expect(await recordHold({ dealId: "shs-x", listing: "t", amountUsd: 1, card: null, agent: null })).toBe(false);
    expect(await recordSettlement("shs-x", { status: "CAPTURED", verdict: { kind: "NO_MATCH", reason: "r" } })).toBe(false);
    expect(await getDeal("shs-x")).toBeUndefined();
    expect(await board()).toBeNull();
  });
  it("the deal and QR endpoints only accept our deal id shape", async () => {
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    expect((await dealGet(new Request("http://x"), ctx("../../etc"))).status).toBe(400);
    expect((await qrGet(new Request("http://x/api/qr?deal=https://evil.example"))).status).toBe(400);
    const ok = await qrGet(new Request("http://x/api/qr?deal=shs-0123abcd-4567"));
    expect(ok.headers.get("content-type")).toBe("image/svg+xml");
    expect(await ok.text()).toContain("<svg");
  });
});
