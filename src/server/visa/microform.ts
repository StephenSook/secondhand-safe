import { signedHeaders, type VisaCreds } from "./acceptance";

/**
 * Visa Acceptance Microform (PLAN 3.9): the card number and CVV are typed into Visa-hosted iframes and become a
 * short-lived transient token in the browser. Our server only ever sees that token, never the card.
 * The capture context is a Visa-signed JWT naming the exact page origins allowed to host the fields.
 */
const PROD_ORIGINS = ["https://secondhand-safe-web.vercel.app", "https://lullabuy.tech", "https://www.lullabuy.tech"];
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/;

/** Only our own origins get a capture context: Visa refuses to render the fields on any other page.
 *  localhost is accepted only off the production deployment. Origin is a client header, so this limits whose
 *  pages can host the fields, not who can call the route: the per-IP limit below covers that. */
export function allowedOrigin(origin: string | null | undefined, allowLocal = process.env.VERCEL_ENV !== "production"): string | null {
  if (!origin) return null;
  const o = origin.trim().replace(/\/$/, "");
  return PROD_ORIGINS.includes(o) || (allowLocal && LOCAL.test(o)) ? o : null;
}

/** Fixed-window limit per client IP per server instance: each call is a signed request under our merchant id.
 *  60 a minute leaves room for a whole venue behind one NAT. */
const hits = new Map<string, { n: number; t: number }>();
export function underLimit(key: string, max = 60, windowMs = 60_000, now = Date.now()): boolean {
  const h = hits.get(key);
  if (!h || now - h.t > windowMs) {
    if (hits.size > 5000) hits.clear();
    hits.set(key, { n: 1, t: now });
    return true;
  }
  h.n += 1;
  return h.n <= max;
}

export type ContextResult = { ok: true; jwt: string } | { ok: false; httpStatus: number; reason: string };

export async function captureContext(creds: VisaCreds, origin: string, f: typeof fetch = fetch): Promise<ContextResult> {
  const path = "/microform/v2/sessions";
  const body = JSON.stringify({ targetOrigins: [origin], allowedCardNetworks: ["VISA", "MASTERCARD", "AMEX", "DISCOVER"], clientVersion: "v2" });
  let res: Response;
  try {
    res = await f(`https://${creds.host}${path}`, { method: "POST", headers: signedHeaders(creds, "POST", path, body), body, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    return { ok: false, httpStatus: 0, reason: (e as Error).name };
  }
  const text = await res.text().catch(() => "");
  // success is a bare compact JWT (three base64url parts); anything else is Visa's JSON error
  if (res.status === 201 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(text.trim())) return { ok: true, jwt: text.trim() };
  let reason = `HTTP ${res.status}`;
  try { const j = JSON.parse(text); reason = j.reason ?? j.message ?? j.errorInformation?.reason ?? reason; } catch {}
  return { ok: false, httpStatus: res.status, reason };
}

/** A transient token is a compact JWT; cap its size so a junk body never reaches Visa. */
export const isTransientToken = (t: unknown): t is string => typeof t === "string" && t.length <= 8000 && /^[\w-]+\.[\w-]+\.[\w-]*$/.test(t);
