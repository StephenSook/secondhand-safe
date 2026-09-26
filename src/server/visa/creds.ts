import { requireEnv } from "@/server/env";
import type { VisaCreds } from "./acceptance";

export function visaCreds(): VisaCreds {
  const e = requireEnv(["VISA_MERCHANT_ID", "VISA_KEY_ID", "VISA_SECRET_KEY"]);
  return { merchantId: e.VISA_MERCHANT_ID, keyId: e.VISA_KEY_ID, secret: e.VISA_SECRET_KEY, host: process.env.VISA_HOST?.trim() || "apitest.cybersource.com" };
}

/** Visa's published sandbox test card. Used only against apitest.cybersource.com until Microform (PLAN 2.4). */
export const SANDBOX_TEST_CARD = { number: "4111111111111111", expirationMonth: "12", expirationYear: "2031", securityCode: "123" };
