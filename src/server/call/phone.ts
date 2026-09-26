import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Phone numbers for the recall call (PLAN 6.12). US numbers only, normalized to E.164 (+1NXXNXXXXXX). The number
 * is never stored in the clear: the opt-in keeps an AES-256-GCM ciphertext (so the call can be placed) and an HMAC
 * (so the per-number cap can count it), both keyed from RECALL_CALL_SECRET, and expires with a TTL.
 */
const PREMIUM = new Set(["900", "976"]);
const CALLABLE = new Set(["FIXED_LINE", "MOBILE", "FIXED_LINE_OR_MOBILE"]);

/** Region US exactly (libphonenumber full metadata): Canada, the Caribbean and the US territories are refused, and
 *  so are premium-rate, shared-cost, toll-free and service numbers, 900/976 and N11 codes in the area code OR the
 *  exchange, and the 555-01XX range reserved for fiction. */
export function parseUsPhone(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const trimmed = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const p = parsePhoneNumberFromString(trimmed, "US");
  if (!p || !p.isValid() || p.country !== "US") return null;
  const type = p.getType();
  if (!type || !CALLABLE.has(type)) return null;
  const d = p.nationalNumber;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null;
  const area = d.slice(0, 3), exch = d.slice(3, 6);
  for (const code of [area, exch]) {
    if (PREMIUM.has(code)) return null;
    if (code[1] === "1" && code[2] === "1") return null; // N11 (211, 311, 411, 511, 611, 711, 811, 911)
  }
  if (exch === "555" && d.slice(6, 8) === "01") return null;
  return `+1${d}`;
}

export const last4 = (e164: string) => e164.slice(-4);

export const phoneHash = (secret: string, e164: string) => createHmac("sha256", `recall-call-num:${secret}`).update(e164).digest("hex");

const encKey = (secret: string) => createHash("sha256").update(`recall-call-enc:${secret}`).digest();

export function sealPhone(secret: string, e164: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", encKey(secret), iv);
  const body = Buffer.concat([c.update(e164, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

export function openPhone(secret: string, sealed: string): string | null {
  try {
    const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const d = createDecipheriv("aes-256-gcm", encKey(secret), iv);
    d.setAuthTag(tag);
    const out = Buffer.concat([d.update(body), d.final()]).toString("utf8");
    return parseUsPhone(out);
  } catch {
    return null;
  }
}
