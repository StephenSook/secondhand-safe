import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Phone numbers for the recall call (PLAN 6.12). US numbers only, normalized to E.164 (+1NXXNXXXXXX). The number
 * is never stored in the clear: the opt-in keeps an AES-256-GCM ciphertext (so the call can be placed) and an HMAC
 * (so the per-number cap can count it), both keyed from RECALL_CALL_SECRET, and expires with a TTL.
 */
const PREMIUM = new Set(["900", "976"]);

export function parseUsPhone(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const trimmed = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  let d = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+") && !d.startsWith("1")) return null; // another country code
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return null;
  // NANP: area code and exchange both start 2-9; no N11 service codes; no premium-rate area codes
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null;
  const area = d.slice(0, 3), exch = d.slice(3, 6);
  if (area[1] === "1" && area[2] === "1") return null;
  if (exch[1] === "1" && exch[2] === "1") return null;
  if (PREMIUM.has(area)) return null;
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
