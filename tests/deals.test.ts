import { describe, it, expect } from "vitest";
import { issueDealToken, verifyDealToken } from "@/server/deals/token";
import { decide, settle } from "@/server/deals/settle";
import { checkLabel } from "@/server/recalls/match";

const S = "secret";
const creds = { merchantId: "m", keyId: "k", secret: Buffer.from("x").toString("base64"), host: "apitest.cybersource.com" };

describe("deal token", () => {
  const t = issueDealToken(S, { dealId: "d1", authId: "a1", amountUsd: 64 });
  it("round-trips", () => expect(verifyDealToken(S, t)).toMatchObject({ dealId: "d1", authId: "a1", amountUsd: 64 }));
  it("rejects a tampered amount", () => {
    const [body, sig] = t.split(".");
    const c = JSON.parse(Buffer.from(body, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...c, amountUsd: 1 })).toString("base64url") + "." + sig;
    expect(verifyDealToken(S, forged)).toBeNull();
  });
  it("rejects another key and expiry", () => {
    expect(verifyDealToken("other", t)).toBeNull();
    expect(verifyDealToken(S, t, Date.now() + 13 * 3600_000)).toBeNull();
  });
});

describe("money rule", () => {
  it("captures only on NO_MATCH, reverses on recall or banned type, holds otherwise", () => {
    expect(decide(checkLabel({ model: "ZZT9Q41X" }))).toBe("capture");
    expect(decide(checkLabel({ model: "BHC001", batch: "202408" }))).toBe("reverse");
    expect(decide(checkLabel({ cls: { cls: "crib_bumper", p: 0.9 } }))).toBe("reverse");
    expect(decide(checkLabel({ model: "BHC001", batch: "202511" }))).toBe("hold");
    expect(decide(checkLabel({}))).toBe("hold");
  });
  it("a hold decision never calls Visa", async () => {
    let called = false;
    const f = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    const r = await settle(creds, { dealId: "d", authId: "a", amountUsd: 5 }, checkLabel({}), f);
    expect(r.status).toBe("HELD");
    expect(called).toBe(false);
  });
  it("a failed reversal leaves the deal HELD, never claims REVERSED", async () => {
    const f = (async () => new Response(JSON.stringify({ status: "INVALID_REQUEST" }), { status: 400 })) as unknown as typeof fetch;
    const r = await settle(creds, { dealId: "d", authId: "a", amountUsd: 5 }, checkLabel({ model: "BHC001", batch: "202408" }), f);
    expect(r.status).toBe("HELD");
  });
});
