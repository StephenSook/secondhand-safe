import { describe, it, expect, afterEach, vi } from "vitest";
import { POST } from "@/app/api/pickup/route";
import { issueDealToken } from "@/server/deals/token";

// POST /api/pickup at the route level: what reaches Visa (every Visa call goes through fetch, stubbed here).
const SECRET = Buffer.from("u".repeat(32)).toString("base64"); // built at runtime, not a credential
const env = (mongo = "") => {
  vi.stubEnv("VISA_MERCHANT_ID", "unit_test_merchant");
  vi.stubEnv("VISA_KEY_ID", "00000000-0000-0000-0000-000000000000");
  vi.stubEnv("VISA_SECRET_KEY", SECRET);
  vi.stubEnv("DEAL_TOKEN_SECRET", "");
  vi.stubEnv("MONGODB_URI", mongo);
  vi.stubEnv("SOLANA_SECRET_KEY_B58", "");
};
const token = () => issueDealToken(SECRET, { dealId: "shs-0a1b2c3d4e", authId: "7000000000000000000000", amountUsd: 45 });
const post = (body: unknown) => POST(new Request("http://x/api/pickup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("pickup route", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("REGRESSION: a corrupted recalled UPC (066264914740, from 066264914743) never captures: UNREADABLE, hold kept, no Visa call", async () => {
    env();
    const f = vi.fn(async () => { throw new Error("Visa must not be called"); });
    vi.stubGlobal("fetch", f);
    const r = await post({ token: token(), upc: "066264914740" });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.verdict.kind).toBe("UNREADABLE");
    // no deal store here, so the hold's state cannot be confirmed: UNKNOWN, never HELD
    expect(j).toMatchObject({ status: "UNKNOWN", holdStateUnconfirmed: true, visaCalled: false });
    expect(f).not.toHaveBeenCalled();
  });

  it("REGRESSION: a corrupted recalled UPC plus an unrecognized model (066264914740 + ZZT9Q41X) never captures", async () => {
    env();
    const f = vi.fn(async () => { throw new Error("Visa must not be called"); });
    vi.stubGlobal("fetch", f);
    const j = await (await post({ token: token(), upc: "066264914740", model: "ZZT9Q41X" })).json();
    expect(j.verdict.kind).toBe("NEEDS_CHECK");
    expect(j.status).not.toBe("CAPTURED");
    expect(f).not.toHaveBeenCalled();
  });

  it("REGRESSION: the corrected barcode of a recall UPC printed with a wrong check digit (984343144044) never captures", async () => {
    env();
    const f = vi.fn(async () => { throw new Error("Visa must not be called"); });
    vi.stubGlobal("fetch", f);
    const j = await (await post({ token: token(), upc: "984343144044" })).json();
    expect(j.verdict.kind).toBe("NEEDS_CHECK");
    expect(j.status).not.toBe("CAPTURED");
    expect(f).not.toHaveBeenCalled();
  });

  it("a clean UPC with no deal store is refused before Visa (503, visaCalled false): no claim, no money moves", async () => {
    env();
    const f = vi.fn(async () => { throw new Error("Visa must not be called"); });
    vi.stubGlobal("fetch", f);
    const r = await post({ token: token(), upc: "012345678905" });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ visaCalled: false, placed: false });
    expect(f).not.toHaveBeenCalled();
  });
});
