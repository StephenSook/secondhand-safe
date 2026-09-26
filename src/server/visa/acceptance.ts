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
  /** true only when Visa's JSON body was read and carried a status */
  parsed: boolean;
  raw: unknown;
  /** what Visa actually authorized (can be less than asked, e.g. after a card-linked promotion) */
  authorizedUsd?: number;
  /** a Visa card-linked offer applied at authorization */
  promotion?: { description: string; discountUsd: number; receipt: string };
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

/**
 * Success is an ALLOWLIST per operation: authorize -> AUTHORIZED, capture -> PENDING, reversal -> REVERSED.
 * Anything else (including a 2xx with an unexpected or missing status) is not ok. A network failure never
 * throws: it returns status NETWORK_ERROR so callers report "unknown", never a guessed state.
 */
const SUCCESS: Record<string, string> = { authorize: "AUTHORIZED", capture: "PENDING", reverse: "REVERSED" };

async function post(creds: VisaCreds, path: string, payload: object, op: keyof typeof SUCCESS, fetchImpl: typeof fetch = fetch): Promise<VisaResult> {
  const body = JSON.stringify(payload);
  let res: Response;
  try {
    res = await fetchImpl(`https://${creds.host}${path}`, { method: "POST", headers: signedHeaders(creds, "POST", path, body), body, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    return { ok: false, status: "NETWORK_ERROR", httpStatus: 0, reason: (e as Error).name, parsed: false, raw: null };
  }
  const raw = (await res.json().catch(() => ({}))) as {
    id?: string; status?: string; errorInformation?: { reason?: string; message?: string }; reason?: string; message?: string;
    processorInformation?: { responseCode?: string };
    orderInformation?: { amountDetails?: { authorizedAmount?: string } };
    promotionInformation?: { description?: string; discountApplied?: string; receiptData?: string };
  };
  let status = raw.status;
  const authorizedUsd = Number(raw.orderInformation?.amountDetails?.authorizedAmount);
  // Measured in the sandbox: when a Visa card-linked promotion applies (for example "20 percent off" a card's 10th
  // purchase), the authorization reply carries promotionInformation, a lower authorizedAmount and NO status field.
  // Only that exact shape (201, an id, processor response code 00, a promotion and an authorized amount) is read
  // as AUTHORIZED; any other reply without a status stays unconfirmed.
  if (!status && op === "authorize" && res.status === 201 && raw.id && raw.processorInformation?.responseCode === "00"
    && raw.promotionInformation && Number.isFinite(authorizedUsd) && authorizedUsd > 0) {
    status = "AUTHORIZED";
  }
  const st = status ?? "ERROR";
  const promo = raw.promotionInformation;
  return {
    ok: res.ok && st === SUCCESS[op],
    parsed: typeof status === "string",
    status: st,
    id: raw.id,
    httpStatus: res.status,
    reason: raw.errorInformation?.reason ?? raw.reason ?? raw.errorInformation?.message ?? raw.message,
    raw,
    ...(Number.isFinite(authorizedUsd) && authorizedUsd > 0 ? { authorizedUsd } : {}),
    ...(promo ? { promotion: { description: String(promo.description ?? ""), discountUsd: Number(promo.discountApplied ?? 0), receipt: String(promo.receiptData ?? "") } } : {}),
  };
}

const amount = (usd: number) => usd.toFixed(2);

export type PaymentSource =
  | { transientTokenJwt: string }
  | { customerId: string } // a Visa Token Management Service saved card
  | { card: { number: string; expirationMonth: string; expirationYear: string; securityCode?: string } };

/** Authorize and HOLD: capture is false, so no money moves until capture(). */
export function authorize(creds: VisaCreds, opts: { dealId: string; amountUsd: number; source: PaymentSource; saveCard?: boolean }, f?: typeof fetch) {
  const payload = {
    clientReferenceInformation: { code: opts.dealId },
    // saveCard asks Visa's Token Management Service to vault the card and return a customer token
    // partialAuthIndicator false: never hold part of the agreed price (a partial hold would be a hold the buyer
    // did not agree to); checkout still releases one if a PARTIAL_AUTHORIZED ever comes back
    processingInformation: {
      capture: false, authorizationOptions: { partialAuthIndicator: false },
      ...(opts.saveCard ? { actionList: ["TOKEN_CREATE"], actionTokenTypes: ["customer", "paymentInstrument"] } : {}),
    },
    orderInformation: { amountDetails: { totalAmount: amount(opts.amountUsd), currency: "USD" },
      // Cybersource's documented sandbox test billing address: the sandbox's AVS simulation expects it
      // (a Georgia Tech address came back AUTHORIZED_PENDING_REVIEW / AVS_FAILED).
      billTo: { firstName: "John", lastName: "Doe", address1: "1 Market St", locality: "San Francisco",
        administrativeArea: "CA", postalCode: "94105", country: "US", email: "test@cybs.com", phoneNumber: "4158880000" } },
    ...("card" in opts.source
      ? { paymentInformation: { card: opts.source.card } }
      : "customerId" in opts.source
        ? { paymentInformation: { customer: { id: opts.source.customerId } } }
        : { tokenInformation: { transientTokenJwt: opts.source.transientTokenJwt } }),
  };
  return post(creds, "/pts/v2/payments", payload, "authorize", f);
}

/** Full-amount capture of a held authorization (the item passed the pickup check). */
export function capture(creds: VisaCreds, authId: string, opts: { dealId: string; amountUsd: number }, f?: typeof fetch) {
  return post(creds, `/pts/v2/payments/${authId}/captures`, {
    clientReferenceInformation: { code: opts.dealId },
    orderInformation: { amountDetails: { totalAmount: amount(opts.amountUsd), currency: "USD" } },
  }, "capture", f);
}

/** Full-amount reversal of a held authorization (recalled or banned at pickup): the hold is released. */
export function reverse(creds: VisaCreds, authId: string, opts: { dealId: string; amountUsd: number; reason: string }, f?: typeof fetch) {
  return post(creds, `/pts/v2/payments/${authId}/reversals`, {
    clientReferenceInformation: { code: opts.dealId },
    reversalInformation: { amountDetails: { totalAmount: amount(opts.amountUsd) }, reason: opts.reason.slice(0, 100) },
  }, "reverse", f);
}

export const newDealId = () => `shs-${randomUUID().slice(0, 18)}`;
