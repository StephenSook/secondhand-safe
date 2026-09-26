import { createHash, createHmac, randomUUID } from "node:crypto";

/**
 * Visa Acceptance (Cybersource) REST client for the hold: authorize with capture OFF at agreement, then
 * capture the full amount or reverse it at pickup (PLAN D1). HTTP Signature auth (shared secret, HmacSHA256).
 * Card data never touches our server in production: the browser sends a Microform transient token.
 */
export interface VisaCreds { merchantId: string; keyId: string; secret: string; host: string }

export interface VisaResult {
  ok: boolean;
  status: string;
  id?: string;
  httpStatus: number;
  reason?: string;
  raw: unknown;
}

export function signedHeaders(creds: VisaCreds, method: "GET" | "POST", path: string, body: string, date = new Date().toUTCString()) {
  const digest = `SHA-256=${createHash("sha256").update(body, "utf8").digest("base64")}`;
  const lines = [
    `host: ${creds.host}`,
    `date: ${date}`,
    `request-target: ${method.toLowerCase()} ${path}`,
    ...(method === "POST" ? [`digest: ${digest}`] : []),
    `v-c-merchant-id: ${creds.merchantId}`,
  ];
  const names = method === "POST" ? "host date request-target digest v-c-merchant-id" : "host date request-target v-c-merchant-id";
  const signature = createHmac("sha256", Buffer.from(creds.secret, "base64")).update(lines.join("\n"), "utf8").digest("base64");
  return {
    host: creds.host,
    date,
    ...(method === "POST" ? { digest } : {}),
    "v-c-merchant-id": creds.merchantId,
    signature: `keyid="${creds.keyId}", algorithm="HmacSHA256", headers="${names}", signature="${signature}"`,
    "content-type": "application/json;charset=utf-8",
  };
}

async function post(creds: VisaCreds, path: string, payload: object, fetchImpl: typeof fetch = fetch): Promise<VisaResult> {
  const body = JSON.stringify(payload);
  const res = await fetchImpl(`https://${creds.host}${path}`, { method: "POST", headers: signedHeaders(creds, "POST", path, body), body });
  const raw = (await res.json().catch(() => ({}))) as { id?: string; status?: string; errorInformation?: { reason?: string; message?: string }; reason?: string; message?: string };
  const status = raw.status ?? "ERROR";
  return {
    ok: res.ok && !["DECLINED", "INVALID_REQUEST", "SERVER_ERROR"].includes(status),
    status,
    id: raw.id,
    httpStatus: res.status,
    reason: raw.errorInformation?.reason ?? raw.reason ?? raw.errorInformation?.message ?? raw.message,
    raw,
  };
}

const amount = (usd: number) => usd.toFixed(2);

export type PaymentSource =
  | { transientTokenJwt: string }
  | { card: { number: string; expirationMonth: string; expirationYear: string; securityCode?: string } };

/** Authorize and HOLD: capture is false, so no money moves until capture(). */
export function authorize(creds: VisaCreds, opts: { dealId: string; amountUsd: number; source: PaymentSource }, f?: typeof fetch) {
  const payload = {
    clientReferenceInformation: { code: opts.dealId },
    processingInformation: { capture: false },
    orderInformation: { amountDetails: { totalAmount: amount(opts.amountUsd), currency: "USD" },
      // Cybersource's documented sandbox test billing address: the sandbox's AVS simulation expects it
      // (a Georgia Tech address came back AUTHORIZED_PENDING_REVIEW / AVS_FAILED).
      billTo: { firstName: "John", lastName: "Doe", address1: "1 Market St", locality: "San Francisco",
        administrativeArea: "CA", postalCode: "94105", country: "US", email: "test@cybs.com", phoneNumber: "4158880000" } },
    ...("card" in opts.source
      ? { paymentInformation: { card: opts.source.card } }
      : { tokenInformation: { transientTokenJwt: opts.source.transientTokenJwt } }),
  };
  return post(creds, "/pts/v2/payments", payload, f);
}

/** Full-amount capture of a held authorization (the item passed the pickup check). */
export function capture(creds: VisaCreds, authId: string, opts: { dealId: string; amountUsd: number }, f?: typeof fetch) {
  return post(creds, `/pts/v2/payments/${authId}/captures`, {
    clientReferenceInformation: { code: opts.dealId },
    orderInformation: { amountDetails: { totalAmount: amount(opts.amountUsd), currency: "USD" } },
  }, f);
}

/** Full-amount reversal of a held authorization (recalled or banned at pickup): the hold is released. */
export function reverse(creds: VisaCreds, authId: string, opts: { dealId: string; amountUsd: number; reason: string }, f?: typeof fetch) {
  return post(creds, `/pts/v2/payments/${authId}/reversals`, {
    clientReferenceInformation: { code: opts.dealId },
    reversalInformation: { amountDetails: { totalAmount: amount(opts.amountUsd) }, reason: opts.reason.slice(0, 100) },
  }, f);
}

export const newDealId = () => `shs-${randomUUID().slice(0, 18)}`;
