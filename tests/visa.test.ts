import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { signedHeaders, authorize } from "@/server/visa/acceptance";

const creds = { merchantId: "m1", keyId: "k1", secret: Buffer.from("s3cret").toString("base64"), host: "apitest.cybersource.com" };

describe("Visa Acceptance HTTP Signature", () => {
  it("signs host, date, request-target, digest and merchant id in that order", () => {
    const body = '{"a":1}';
    const h = signedHeaders(creds, "POST", "/pts/v2/payments", body, "Sat, 26 Sep 2026 07:00:00 GMT");
    expect(h.digest).toBe("SHA-256=" + createHash("sha256").update(body).digest("base64"));
    const expected = createHmac("sha256", Buffer.from("s3cret"))
      .update(["host: apitest.cybersource.com", "date: Sat, 26 Sep 2026 07:00:00 GMT", "request-target: post /pts/v2/payments",
        `digest: ${h.digest}`, "v-c-merchant-id: m1"].join("\n")).digest("base64");
    expect(h.signature).toBe(`keyid="k1", algorithm="HmacSHA256", headers="host date request-target digest v-c-merchant-id", signature="${expected}"`);
  });

  it("authorize always sends capture:false (the hold) and a 2-decimal amount", async () => {
    let sent: { capture?: boolean; total?: string } = {};
    const f = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      sent = { capture: b.processingInformation.capture, total: b.orderInformation.amountDetails.totalAmount };
      return new Response(JSON.stringify({ id: "123", status: "AUTHORIZED" }), { status: 201 });
    }) as unknown as typeof fetch;
    const r = await authorize(creds, { dealId: "d1", amountUsd: 64, source: { transientTokenJwt: "jwt" } }, f);
    expect(sent).toEqual({ capture: false, total: "64.00" });
    expect(r).toMatchObject({ ok: true, status: "AUTHORIZED", id: "123" });
  });

  it("a DECLINED authorization is not ok", async () => {
    const f = (async () => new Response(JSON.stringify({ id: "9", status: "DECLINED" }), { status: 201 })) as unknown as typeof fetch;
    expect((await authorize(creds, { dealId: "d", amountUsd: 1, source: { transientTokenJwt: "x" } }, f)).ok).toBe(false);
  });
});
