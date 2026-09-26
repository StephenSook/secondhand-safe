import { describe, it, expect } from "vitest";
import { authorize, capture, reverse, newDealId, type VisaCreds } from "@/server/visa/acceptance";

/**
 * PLAN 0.6 gate, live against the Visa Acceptance sandbox (apitest.cybersource.com): auth (HOLD) -> capture,
 * and auth (HOLD) -> reversal. Runs with `npm run test:live` when VISA_* are set. Test card from Visa's
 * published sandbox test numbers.
 */
const e = process.env;
const creds: VisaCreds = { merchantId: e.VISA_MERCHANT_ID ?? "", keyId: e.VISA_KEY_ID ?? "", secret: e.VISA_SECRET_KEY ?? "", host: e.VISA_HOST ?? "apitest.cybersource.com" };
const card = { number: "4111111111111111", expirationMonth: "12", expirationYear: "2031", securityCode: "123" };

describe.skipIf(!e.VISA_MERCHANT_ID)("Visa Acceptance sandbox, live", () => {
  it("authorize (held) then capture the full amount", async () => {
    const dealId = newDealId();
    const auth = await authorize(creds, { dealId, amountUsd: 64, source: { card } });
    console.log("auth", auth.httpStatus, auth.status, auth.id, auth.reason ?? "");
    expect(auth.status).toBe("AUTHORIZED");
    const cap = await capture(creds, auth.id!, { dealId, amountUsd: 64 });
    console.log("capture", cap.httpStatus, cap.status, cap.id);
    expect(cap.status).toBe("PENDING");
  }, 60_000);

  it("authorize (held) then reverse the full amount", async () => {
    const dealId = newDealId();
    const auth = await authorize(creds, { dealId, amountUsd: 64, source: { card } });
    expect(auth.status).toBe("AUTHORIZED");
    const rev = await reverse(creds, auth.id!, { dealId, amountUsd: 64, reason: "CPSC recall 26-061 at pickup" });
    console.log("reversal", rev.httpStatus, rev.status, rev.id, rev.reason ?? "");
    expect(rev.status).toBe("REVERSED");
  }, 60_000);
});
