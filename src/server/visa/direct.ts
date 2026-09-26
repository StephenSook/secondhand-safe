import { constants as cryptoConstants, createCipheriv, createDecipheriv, createHash, createPublicKey, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";
import https from "node:https";
import tls from "node:tls";
import type { Collection } from "mongodb";
import { getDb } from "@/server/db/mongo";
import { INTEGRATIONS, requireEnv } from "@/server/env";

/**
 * Visa Direct push payout to the seller after a capture (PLAN 3.17 / 6.15), on the Visa Developer Platform (VDP)
 * sandbox. One Original Credit Transaction (OCT) per deal, sent at most once.
 *
 * Sources (read 2026-09-26):
 *  [OVERVIEW] https://developer.visa.com/capabilities/visa_direct/docs
 *    "Push funds (OCTs): ... Merchant settlement (marketplace seller earnings)"; sandbox test acquiring BINs are
 *    issued per project in the dashboard.
 *  [HOWTO]    https://developer.visa.com/capabilities/visa_direct/docs-how-to
 *    "If a push funds transaction follows a pull funds, the transaction identifier must be included". Ours
 *    follows a Visa Acceptance capture, not a pull, so transactionIdentifier is not sent.
 *  [ERRORS]   https://developer.visa.com/capabilities/visa_direct/docs-error-codes
 *    HTTP 200 = processed, the actionCode is the outcome; 202 = still processing (statusIdentifier for a GET);
 *    303 = duplicate (X-Client-Transaction-ID); 400/401/403/404 = rejected; 503/504 = "Recommend not to re-post".
 *  [AUTH]     https://developer.visa.com/capabilities/visa_direct/docs-authentication
 *    Two-Way SSL plus the project user name and password.
 *  [TWOWAY]   https://developer.visa.com/pages/working-with-visa-apis/two-way-ssl
 *    client key + client cert + VDP root and intermediate; Visa's SERVER presents a DigiCert Global Root G2
 *    chain, and helloworld is GET https://sandbox.api.visa.com/vdp/helloworld with HTTP Basic.
 *  [SAMPLE]   https://community.developer.visa.com/t5/Sandbox-Test-Data/help/td-p/22526
 *    A Visa Developer Support Specialist's successful sandbox push (2023-08-25). Every field value below that is
 *    marked [SAMPLE] is copied from that request. The official field reference
 *    (https://developer.visa.com/capabilities/visa_direct/reference) is a JavaScript app that did not render for
 *    us, so field lengths and formats beyond that sample are NOT verified against it.
 *
 *  [HEADERS]  https://developer.visa.com/capabilities/visa_direct/docs-request-response-headers
 *    X-Transaction-Timeout-MS, x-client-transaction-id, keyId (MLE), X-Correlation-id in every response.
 *  [MLE]      https://developer.visa.com/pages/encryption_guide
 *    Message Level Encryption: a `keyId` request header; the body is {"encData": <JWE compact>} with protected
 *    header {"alg":"RSA-OAEP-256","enc":"A128GCM","iat":<ms>,"kid":<keyId>} ("The iat field will be valid for two
 *    minutes"), encrypted to Visa's server encryption certificate; Visa encrypts the reply the same way to the
 *    client MLE key. [MLE9125] https://community.developer.visa.com/t5/Implementation-API-Sample-Code/400-9125-Expected-input-credential-was-not-present/td-p/25618
 *    ("the problem was MLE enforced").
 *
 * KNOWN LIMITS (recorded, not solved here): the payout fires when Visa Acceptance accepts the capture (its answer
 * is PENDING until the batch settles), not when it settles; there is no reconciliation worker, so a 202, 303,
 * timeout or crash-left claim stays UNCERTAIN until a person checks it with the stored statusIdentifier or
 * X-Correlation-id; and the trigger lives in waitUntil, not a durable queue, so a function killed before the claim
 * means no payout (never a double one).
 *
 * MEASURED 2026-09-26 on our project: helloworld 200, push 400 error 9125 "Expected input credential was not
 * present" without MLE. So MLE is used whenever its three VISA_DIRECT_MLE_* variables are set.
 */

export type PayoutStatus = "SENT" | "UNCERTAIN" | "FAILED" | "NOT_CONFIGURED";

/** Everything a payout needs: two-way TLS plus MLE. /api/health reports visaDirect true only with all of them. */
export const VISA_DIRECT_ENV = INTEGRATIONS.visaDirect;
/** Enough for the helloworld connectivity probe (two-way TLS only). */
export const VISA_DIRECT_TLS_ENV = ["VISA_DIRECT_USER_ID", "VISA_DIRECT_PASSWORD", "VISA_DIRECT_CERT", "VISA_DIRECT_KEY", "VISA_DIRECT_CA"] as const;
export const SANDBOX_HOST = "sandbox.api.visa.com"; // [TWOWAY]
export const PUSH_PATH = "/visadirect/fundstransfer/v1/pushfundstransactions"; // [SAMPLE] endpoint
export const HELLO_PATH = "/vdp/helloworld"; // [TWOWAY]
/** [HEADERS] X-Transaction-Timeout-MS (default and maximum 30000). Kept below the client timeout below. */
export const VISA_TIMEOUT_MS = 10_000;

/** [SAMPLE] acquiringBin 408999 and acquirerCountryCode 840. [OVERVIEW]: each project's dashboard lists its own
 *  test BINs, so VISA_DIRECT_ACQUIRING_BIN overrides it when that dashboard shows a different one. */
export const SAMPLE_ACQUIRING_BIN = "408999";
export const ACQUIRER_COUNTRY_CODE = "840";
/** The sandbox recipient card. We have no seller card on file, so every sandbox payout goes to a Visa test card
 *  and the UI says so. The sandbox answers by test scenario: the Visa sandbox test-data table a Visa support
 *  specialist quoted at https://community.developer.visa.com/t5/Product-Functionality-Errors/MultiPushFunds-Invalid-input-found-please-correct-the-input-data/td-p/12518
 *  lists recipient ...0496 (the [SAMPLE] card) as the "Action Code-65" scenario, and recipient ...0462 as an
 *  "Action Code-00" scenario (approvalCode 21324K). MEASURED 2026-09-26: ...0496 came back 200 / actionCode 65, as
 *  that table says. That table is for multi push; whether ...0462 approves a single push is NOT yet measured.
 *  VISA_DIRECT_RECIPIENT_PAN overrides it with a card from the project dashboard's own Test Data page. */
export const SANDBOX_RECIPIENT_PAN = "4957030420210462";
/** [SAMPLE] senderAccountNumber. */
const SAMPLE_SENDER_ACCOUNT = "4653459515756154";

export interface MleCreds { keyId: string; serverCert: string; clientKey: string }
export interface VisaDirectCreds { userId: string; password: string; cert: string; key: string; ca: string; host: string; acquiringBin: string; mle: MleCreds | null }
export const VISA_DIRECT_MLE_ENV = ["VISA_DIRECT_MLE_KEY_ID", "VISA_DIRECT_MLE_SERVER_CERT", "VISA_DIRECT_MLE_PRIVATE_KEY"] as const;

/** Vercel env values pasted on one line carry literal "\n"; PEM parsing needs real newlines. */
const pem = (v: string) => v.replace(/\\n/g, "\n").trim();

/** mle "required" (the payout) throws MissingEnvError without the MLE keys; "optional" (the probe) does not. */
export function visaDirectCreds(src: Record<string, string | undefined> = process.env, mle: "required" | "optional" = "required"): VisaDirectCreds {
  const e = requireEnv(mle === "required" ? VISA_DIRECT_ENV : VISA_DIRECT_TLS_ENV, src);
  return {
    userId: e.VISA_DIRECT_USER_ID, password: e.VISA_DIRECT_PASSWORD,
    cert: pem(e.VISA_DIRECT_CERT), key: pem(e.VISA_DIRECT_KEY), ca: pem(e.VISA_DIRECT_CA),
    host: src.VISA_DIRECT_HOST?.trim() || SANDBOX_HOST,
    acquiringBin: src.VISA_DIRECT_ACQUIRING_BIN?.trim() || SAMPLE_ACQUIRING_BIN,
    mle: VISA_DIRECT_MLE_ENV.every((k) => (src[k] ?? "").trim().length > 0)
      ? { keyId: src.VISA_DIRECT_MLE_KEY_ID!.trim(), serverCert: pem(src.VISA_DIRECT_MLE_SERVER_CERT!), clientKey: pem(src.VISA_DIRECT_MLE_PRIVATE_KEY!) }
      : null,
  };
}

// ---------- Message Level Encryption ([MLE]): JWE compact, RSA-OAEP-256 + A128GCM, node:crypto only ----------

const b64u = (b: Buffer) => b.toString("base64url");

/** Encrypts a JSON body to Visa's server encryption certificate. Returns the JWE compact string. */
export function mleEncrypt(plaintext: string, m: Pick<MleCreds, "keyId" | "serverCert">, now = Date.now()): string {
  const protectedHeader = b64u(Buffer.from(JSON.stringify({ alg: "RSA-OAEP-256", enc: "A128GCM", iat: now, kid: m.keyId }), "utf8"));
  const cek = randomBytes(16); // A128GCM content key
  const iv = randomBytes(12); // 96-bit IV
  // createPublicKey reads the public key out of Visa's X.509 certificate (or a bare public key PEM)
  const ek = publicEncrypt({ key: createPublicKey(m.serverCert), padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, cek);
  const cipher = createCipheriv("aes-128-gcm", cek, iv);
  cipher.setAAD(Buffer.from(protectedHeader, "ascii"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [protectedHeader, b64u(ek), b64u(iv), b64u(ct), b64u(cipher.getAuthTag())].join(".");
}

/** Decrypts a JWE compact string sent by Visa to our client MLE key (A128GCM or A256GCM). */
export function mleDecrypt(jwe: string, clientKey: string): string {
  const parts = jwe.split(".");
  if (parts.length !== 5) throw new Error("not a JWE compact string");
  const [h, ek, iv, ct, tag] = parts;
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string; enc?: string };
  if (header.alg !== "RSA-OAEP-256") throw new Error(`unexpected JWE alg ${header.alg}`);
  const algo = header.enc === "A128GCM" ? "aes-128-gcm" : header.enc === "A256GCM" ? "aes-256-gcm" : null;
  if (!algo) throw new Error(`unexpected JWE enc ${header.enc}`);
  const cek = privateDecrypt({ key: clientKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(ek, "base64url"));
  const d = createDecipheriv(algo, cek, Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(h, "ascii"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

// ---------- pure helpers (tested without a network) ----------

/** Dollars to integer cents. Rejects anything that is not a positive amount with at most two decimals, so a
 *  float like 19.999 can never become a payout. */
export function toCents(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("payout amount must be a positive number");
  const cents = Math.round(usd * 100);
  if (Math.abs(cents - usd * 100) > 1e-6) throw new Error("payout amount has more than two decimals");
  if (cents > 99_999_999) throw new Error("payout amount is too large");
  return cents;
}

/** Integer cents to Visa's decimal string ([SAMPLE] "124.05"), with no floating point on the way. */
export function centsToAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("cents must be a positive integer");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Luhn check plus 13 to 19 digits (the ISO/IEC 7812 card number rule). */
export function validPan(pan: string): boolean {
  if (!/^\d{13,19}$/.test(pan)) return false;
  let sum = 0;
  for (let i = 0; i < pan.length; i++) {
    let d = pan.charCodeAt(pan.length - 1 - i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** The only form of a card number that ever leaves this module. */
export const panLast4 = (pan: string) => pan.slice(-4);

/**
 * systemsTraceAuditNumber: 6 digits ([SAMPLE] "451018"), derived from the deal id so one deal always has one.
 * retrievalReferenceNumber: 12 digits laid out ydddhhnnnnnn. [ERRORS] rejects an RRN whose day is outside 1-366,
 * which is this layout's ddd; the full layout is from the community SDK github.com/ksred/visa (VisaDirect.go),
 * not from Visa's own reference.
 */
export function traceNumbers(dealId: string, now: Date): { stan: string; rrn: string } {
  const h = createHash("sha256").update(dealId).digest();
  const stan = String(h.readUInt32BE(0) % 1_000_000).padStart(6, "0");
  const y = String(now.getUTCFullYear() % 10);
  const start = Date.UTC(now.getUTCFullYear(), 0, 1);
  const ddd = String(Math.floor((now.getTime() - start) / 86_400_000) + 1).padStart(3, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  return { stan, rrn: `${y}${ddd}${hh}${stan}` };
}

/** [SAMPLE] localTransactionDateTime "2023-08-25T19:17:28": no zone, no milliseconds. */
export const localDateTime = (now: Date) => now.toISOString().slice(0, 19);

/** Visa's X-Client-Transaction-ID header: [ERRORS] 303 is a duplicate "with the same header (e.g.
 *  X-Client-Transaction-ID)". One value per deal, so even a resend Visa sees is recognised as the same payout. */
export const clientTransactionId = (dealId: string) => `lullabuy-payout-${dealId}`;

export interface PushPayload {
  amount: string; localTransactionDateTime: string; recipientPrimaryAccountNumber: string;
  acquiringBin: string; acquirerCountryCode: string; retrievalReferenceNumber: string; systemsTraceAuditNumber: string;
  businessApplicationId: string; merchantCategoryCode: string; transactionCurrencyCode: string; sourceOfFundsCode: string;
  settlementServiceIndicator: string; senderAccountNumber: string; senderName: string; senderAddress: string;
  senderCity: string; senderStateCode: string; senderCountryCode: string; senderReference: string; recipientName: string;
  pointOfServiceData: { panEntryMode: string; posConditionCode: string; motoECIIndicator: string };
  cardAcceptor: { name: string; idCode: string; terminalId: string; address: { country: string; state: string; county: string; zipCode: string } };
}

export function buildPushPayload(p: { dealId: string; amountCents: number; recipientPan: string; acquiringBin: string; now: Date }): PushPayload {
  const { stan, rrn } = traceNumbers(p.dealId, p.now);
  return {
    amount: centsToAmount(p.amountCents),
    localTransactionDateTime: localDateTime(p.now),
    recipientPrimaryAccountNumber: p.recipientPan,
    acquiringBin: p.acquiringBin,
    acquirerCountryCode: ACQUIRER_COUNTRY_CODE,
    retrievalReferenceNumber: rrn,
    systemsTraceAuditNumber: stan,
    // [SAMPLE] "AA". [OVERVIEW] lists marketplace seller earnings as a push use case; the business application id
    // Visa assigns to that use case is not stated on any page we could read, so the sample's value is kept.
    businessApplicationId: "AA",
    merchantCategoryCode: "6012", // [SAMPLE]
    transactionCurrencyCode: "USD", // [SAMPLE]
    sourceOfFundsCode: "05", // [SAMPLE]
    settlementServiceIndicator: "9", // [SAMPLE]
    senderAccountNumber: SAMPLE_SENDER_ACCOUNT, // [SAMPLE]
    senderName: "Lullabuy", // free text; [SAMPLE] sent a person's name here
    senderAddress: "901 Metro Center Blvd", // [SAMPLE]
    senderCity: "Foster City", // [SAMPLE]
    senderStateCode: "CA", // [SAMPLE]
    senderCountryCode: "840", // ISO 3166 numeric for the USA ([SAMPLE] sent 124, Canada)
    senderReference: "", // [SAMPLE]; our reference travels in X-Client-Transaction-ID instead
    recipientName: "Lullabuy seller", // free text ([SAMPLE] sent a first name)
    pointOfServiceData: { panEntryMode: "90", posConditionCode: "00", motoECIIndicator: "0" }, // [SAMPLE]
    cardAcceptor: { // [SAMPLE], except the name
      name: "Lullabuy", idCode: "CA-IDCode-77765", terminalId: "TID-9999",
      address: { country: "USA", state: "CA", county: "San Mateo", zipCode: "94404" },
    },
  };
}

/** What Visa's answer means for the money. Only the fields we keep are returned; the raw body never is. */
export interface Classified {
  status: Exclude<PayoutStatus, "NOT_CONFIGURED">;
  note: string;
  actionCode?: string; transactionIdentifier?: string; approvalCode?: string; statusIdentifier?: string; errorCode?: string;
}

const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).slice(0, 40) : undefined);
/** error text from Visa, with any long digit run (a card number, if one were ever echoed) removed */
const scrub = (v: unknown) => (typeof v === "string" ? v.replace(/\d{12,}/g, "[digits removed]").slice(0, 160) : undefined);

export function classify(httpStatus: number, body: unknown): Classified {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const rs = (b.responseStatus && typeof b.responseStatus === "object" ? b.responseStatus : {}) as Record<string, unknown>;
  const keep = {
    actionCode: str(b.actionCode), transactionIdentifier: str(b.transactionIdentifier), approvalCode: str(b.approvalCode),
    statusIdentifier: str(b.statusIdentifier), errorCode: str(rs.code),
  };
  const kept = Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined));
  if (httpStatus === 200) {
    // [ERRORS] 200: "The Action Code returned in the response indicates the outcome"; 00 is approved (ISO 8583)
    if (keep.actionCode === "00") return { status: "SENT", note: "Visa Direct approved the push to the seller", ...kept };
    if (keep.actionCode) return { status: "FAILED", note: `Visa Direct processed the push and did not approve it (action code ${keep.actionCode})`, ...kept };
    return { status: "UNCERTAIN", note: "Visa Direct answered 200 without an action code; not re-sent", ...kept };
  }
  if (httpStatus === 202) return { status: "UNCERTAIN", note: "Visa Direct is still processing the push (202); not re-sent", ...kept };
  if (httpStatus === 303) return { status: "UNCERTAIN", note: "Visa Direct saw this payout already (303 duplicate); not re-sent", ...kept };
  if ([400, 401, 403, 404].includes(httpStatus)) {
    const msg0 = scrub(rs.message) ?? scrub(b.errorMessage) ?? scrub(b.message);
    // [MLE9125]: on an endpoint where helloworld passes, 9125 means Message Level Encryption is enforced
    const msg = keep.errorCode === "9125" ? `${msg0 ?? "credential missing"} (Message Level Encryption is required: set VISA_DIRECT_MLE_*)` : msg0;
    return { status: "FAILED", note: `Visa Direct rejected the push (HTTP ${httpStatus}${keep.errorCode ? `, error ${keep.errorCode}` : ""})${msg ? `: ${msg}` : ""}`, ...kept };
  }
  // 5xx and anything else: [ERRORS] "Recommend not to re-post transaction and check settlement report"
  return { status: "UNCERTAIN", note: `Visa Direct answered HTTP ${httpStatus}; outcome unknown, not re-sent`, ...kept };
}

// ---------- transport (two-way TLS) ----------

export interface TransportRequest { method: "GET" | "POST"; path: string; body?: string; headers: Record<string, string> }
export type Transport = (r: TransportRequest) => Promise<{ httpStatus: number; text: string; correlationId?: string }>;

/** A transport failure. `sent` is false only when the TLS handshake never completed, so Visa cannot have
 *  received the request; any failure after that is treated as "may have been sent". */
export class TransportError extends Error {
  constructor(message: string, public readonly sent: boolean, public readonly timedOut = false) {
    super(message);
    this.name = "TransportError";
  }
}

export function basicAuth(c: Pick<VisaDirectCreds, "userId" | "password">) {
  return `Basic ${Buffer.from(`${c.userId}:${c.password}`, "utf8").toString("base64")}`;
}

export function httpsTransport(c: VisaDirectCreds, timeoutMs = 15_000): Transport {
  const agent = new https.Agent({
    key: c.key,
    // our certificate plus Visa's chain, so the server can build the path to the VDP root
    cert: `${c.cert}\n${c.ca}`,
    // Visa's server certificate chains to DigiCert ([TWOWAY]): keep Node's public roots and add Visa's CA
    ca: [...tls.rootCertificates, c.ca],
    keepAlive: false,
  });
  return (r) => new Promise((resolve, reject) => {
    try {
      // a malformed PEM throws here, synchronously, before any connection: nothing can have reached Visa
      tls.createSecureContext({ key: c.key, cert: c.cert, ca: c.ca });
    } catch (e) {
      reject(new TransportError(`bad TLS credentials: ${(e as Error).message}`, false));
      return;
    }
    let handshaken = false;
    let settled = false;
    const req = https.request({ host: c.host, port: 443, method: r.method, path: r.path, agent, headers: {
      ...r.headers, ...(r.body !== undefined ? { "content-length": String(Buffer.byteLength(r.body)) } : {}),
    } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      // [HEADERS] X-Correlation-id: "Provide this value to Visa when requesting any transaction investigation"
      const cid = res.headers["x-correlation-id"];
      res.on("end", () => done(() => resolve({ httpStatus: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"),
        ...(typeof cid === "string" ? { correlationId: cid.slice(0, 80) } : {}) })));
      res.on("error", (e) => done(() => reject(new TransportError(e.message, true))));
    });
    const timer = setTimeout(() => {
      done(() => reject(new TransportError(`timed out after ${timeoutMs} ms`, handshaken, true)));
      req.destroy();
    }, timeoutMs);
    function done(fn: () => void) { if (!settled) { settled = true; clearTimeout(timer); fn(); } }
    req.on("socket", (s) => s.once("secureConnect", () => { handshaken = true; }));
    req.on("error", (e) => done(() => reject(new TransportError(e.message, handshaken))));
    if (r.body !== undefined) req.write(r.body);
    req.end();
  });
}

/** Connectivity probe: [TWOWAY] GET /vdp/helloworld answers 200 with the current timestamp when the client
 *  certificate, key, CA and user id / password are all right. */
export async function helloWorld(c: VisaDirectCreds, transport: Transport = httpsTransport(c, 10_000)): Promise<{ ok: boolean; httpStatus: number; error?: string }> {
  try {
    const r = await transport({ method: "GET", path: HELLO_PATH, headers: { accept: "application/json", authorization: basicAuth(c) } });
    return { ok: r.httpStatus === 200, httpStatus: r.httpStatus };
  } catch (e) {
    return { ok: false, httpStatus: 0, error: (e as Error).message };
  }
}

// ---------- the idempotency store (MongoDB Atlas `payouts`, _id = dealId) ----------

/** Private: never sent to a browser. No card number, only its last four digits. */
export interface PayoutDoc {
  _id: string; state: "CLAIMED" | Exclude<PayoutStatus, "NOT_CONFIGURED">;
  amountCents: number; recipientLast4: string; stan: string; rrn: string; claimedAt: string; finishedAt?: string;
  httpStatus?: number; note?: string; correlationId?: string;
  actionCode?: string; transactionIdentifier?: string; approvalCode?: string; statusIdentifier?: string; errorCode?: string;
}

export interface PayoutStore {
  /** Atomic: exactly one caller per deal gets "claimed". "unavailable" means we could not prove we hold the claim. */
  claim(doc: PayoutDoc): Promise<{ state: "claimed" } | { state: "exists"; doc: PayoutDoc | null } | { state: "unavailable" }>;
  finish(dealId: string, fields: Partial<PayoutDoc>): Promise<boolean>;
  /** Drops a claim whose request provably never left this process, so a later attempt may send it. */
  release(dealId: string): Promise<boolean>;
}

async function withDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([fn(), new Promise<never>((_, bad) => { timer = setTimeout(() => bad(new Error(`timed out after ${ms} ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}

export function mongoPayoutStore(): PayoutStore {
  const col = async (): Promise<Collection<PayoutDoc> | null> => { const db = await getDb(); return db ? db.collection<PayoutDoc>("payouts") : null; };
  return {
    async claim(doc) {
      try {
        const c = await withDeadline(6000, col);
        if (!c) return { state: "unavailable" };
        // the same pattern as the deals store: insertOne on _id is atomic, a second insert fails with E11000
        await withDeadline(6000, () => c.insertOne(doc));
        return { state: "claimed" };
      } catch (e) {
        if ((e as { code?: number }).code === 11000) {
          const c = await col().catch(() => null);
          const existing = c ? await c.findOne({ _id: doc._id }).catch(() => null) : null;
          return { state: "exists", doc: existing };
        }
        // a timed-out insert may still have landed: we cannot prove the claim is ours, so nothing is sent
        console.warn("[visa-direct] claim failed:", (e as Error).message);
        return { state: "unavailable" };
      }
    },
    async finish(dealId, fields) {
      try {
        const c = await withDeadline(6000, col);
        if (!c) return false;
        const r = await withDeadline(6000, () => c.updateOne({ _id: dealId, state: "CLAIMED" }, { $set: fields }));
        return r.modifiedCount === 1;
      } catch (e) {
        // the claim stays CLAIMED, which reads as UNCERTAIN and is never re-sent
        console.warn("[visa-direct] finish failed:", (e as Error).message);
        return false;
      }
    },
    async release(dealId) {
      try {
        const c = await withDeadline(6000, col);
        if (!c) return false;
        const r = await withDeadline(6000, () => c.deleteOne({ _id: dealId, state: "CLAIMED" }));
        return r.deletedCount === 1;
      } catch (e) {
        // the claim stays CLAIMED (reads as UNCERTAIN): safe, never a second send
        console.warn("[visa-direct] release failed:", (e as Error).message);
        return false;
      }
    },
  };
}

// ---------- the payout ----------

export interface PayoutResult {
  status: PayoutStatus;
  dealId: string;
  amountUsd: number;
  /** "card ending 0462": never more of the card number than this */
  recipient: string | null;
  note: string;
  /** true when this deal's payout had already been claimed by an earlier call; nothing was sent this time */
  duplicate?: boolean;
  httpStatus?: number;
  actionCode?: string;
  transactionIdentifier?: string;
}

export interface PushDeps {
  env?: Record<string, string | undefined>;
  store?: PayoutStore;
  transport?: Transport;
  now?: () => Date;
}

const ending = (last4: string) => `card ending ${last4}`;

/** A provably unsent request frees its claim. If the release itself fails, the claim is closed as FAILED so the
 *  store agrees with what we report (still never a second send: a closed claim is never re-sent). */
async function releaseOrFail(store: PayoutStore, dealId: string, note: string) {
  if (!(await store.release(dealId))) await store.finish(dealId, { state: "FAILED", note, finishedAt: new Date().toISOString() });
}

export async function pushFunds(p: { dealId: string; amountUsd: number; recipientPan?: string }, deps: PushDeps = {}): Promise<PayoutResult> {
  const env = deps.env ?? process.env;
  const base = { dealId: p.dealId, amountUsd: p.amountUsd, recipient: null as string | null };
  let creds: VisaDirectCreds;
  try {
    creds = visaDirectCreds(env);
  } catch {
    return { ...base, status: "NOT_CONFIGURED", note: "Visa Direct credentials are not configured; nothing sent" };
  }
  let cents: number;
  try { cents = toCents(p.amountUsd); } catch (e) {
    return { ...base, status: "FAILED", note: `Not sent: ${(e as Error).message}` };
  }
  const pan = (p.recipientPan ?? (env.VISA_DIRECT_RECIPIENT_PAN?.trim() || SANDBOX_RECIPIENT_PAN)).replace(/\s+/g, "");
  if (!validPan(pan)) return { ...base, status: "FAILED", note: "Not sent: the recipient card number is not valid" };
  const recipient = ending(panLast4(pan));
  const now = (deps.now ?? (() => new Date()))();
  const payload = buildPushPayload({ dealId: p.dealId, amountCents: cents, recipientPan: pan, acquiringBin: creds.acquiringBin, now });
  const store = deps.store ?? mongoPayoutStore();

  const claim = await store.claim({ _id: p.dealId, state: "CLAIMED", amountCents: cents, recipientLast4: panLast4(pan),
    stan: payload.systemsTraceAuditNumber, rrn: payload.retrievalReferenceNumber, claimedAt: now.toISOString() });
  if (claim.state === "unavailable") {
    return { ...base, recipient, status: "FAILED", note: "Not sent: the payout could not be claimed in the idempotency store, so a double payout could not be ruled out" };
  }
  if (claim.state === "exists") {
    const d = claim.doc;
    const status: PayoutStatus = !d || d.state === "CLAIMED" ? "UNCERTAIN" : d.state;
    return { ...base, recipient: d ? ending(d.recipientLast4) : recipient, status, duplicate: true,
      note: `This deal's payout was already claimed (${d?.state ?? "unknown state"}); nothing sent again`,
      ...(d?.transactionIdentifier ? { transactionIdentifier: d.transactionIdentifier } : {}), ...(d?.actionCode ? { actionCode: d.actionCode } : {}) };
  }

  let requestBody: string;
  try {
    const plain = JSON.stringify(payload);
    requestBody = creds.mle ? JSON.stringify({ encData: mleEncrypt(plain, creds.mle) }) : plain;
  } catch (e) {
    // nothing left this process: a bad MLE certificate is a definite failure, not an uncertain send, and the
    // claim is released so the payout can still be sent once the configuration is fixed
    const note = `Not sent: could not encrypt the request (${(e as Error).message})`;
    await releaseOrFail(store, p.dealId, note);
    return { ...base, recipient, status: "FAILED", note };
  }
  let result: PayoutResult;
  let finish: Partial<PayoutDoc>;
  try {
    const transport = deps.transport ?? httpsTransport(creds);
    const r = await transport({ method: "POST", path: PUSH_PATH, body: requestBody,
      headers: {
        accept: "application/json", "content-type": "application/json", authorization: basicAuth(creds),
        "x-client-transaction-id": clientTransactionId(p.dealId),
        // [HEADERS] Visa answers 202 (still processing) after this many ms, safely inside our 15 s client timeout,
        // so a slow push comes back as a 202 with a statusIdentifier instead of a client-side timeout
        "x-transaction-timeout-ms": String(VISA_TIMEOUT_MS),
        ...(creds.mle ? { keyId: creds.mle.keyId } : {}),
      } });
    let body: unknown = null;
    try { body = JSON.parse(r.text); } catch { body = null; }
    // an MLE reply is {"encData": JWE}; errors can come back in the clear
    const enc = body && typeof body === "object" ? (body as { encData?: unknown }).encData : undefined;
    if (typeof enc === "string" && creds.mle) {
      try { body = JSON.parse(mleDecrypt(enc, creds.mle.clientKey)); } catch { body = null; }
    }
    const c = body === null && r.httpStatus === 200
      ? { status: "UNCERTAIN" as const, note: "Visa Direct answered 200 with a body we could not read; not re-sent" }
      : classify(r.httpStatus, body);
    const { status, note, ...fields } = c;
    result = { ...base, recipient, status, note, httpStatus: r.httpStatus,
      ...(fields.actionCode ? { actionCode: fields.actionCode } : {}), ...(fields.transactionIdentifier ? { transactionIdentifier: fields.transactionIdentifier } : {}) };
    finish = { state: status, httpStatus: r.httpStatus, note, ...fields, ...(r.correlationId ? { correlationId: r.correlationId } : {}) };
  } catch (e) {
    const te = e instanceof TransportError ? e : new TransportError((e as Error).message, true);
    if (!te.sent) {
      // the TLS handshake never completed, so Visa never saw it: release the claim for a later attempt
      const note = `Not sent: could not connect to Visa Direct (${te.message})`;
      await releaseOrFail(store, p.dealId, note);
      console.info(`[visa-direct] ${p.dealId}: FAILED before sending`);
      return { ...base, recipient, status: "FAILED", note };
    }
    const status = "UNCERTAIN";
    const note = `Visa Direct did not answer (${te.timedOut ? "timed out" : te.message}); the push may have reached Visa, so it is not re-sent`;
    result = { ...base, recipient, status, note };
    finish = { state: status, note };
  }
  await store.finish(p.dealId, { ...finish, finishedAt: new Date().toISOString() });
  console.info(`[visa-direct] ${p.dealId}: ${result.status} ${recipient} ${result.httpStatus ?? ""} ${result.actionCode ?? ""}`.trim());
  return result;
}
