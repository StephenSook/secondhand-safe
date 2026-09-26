import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Visa Token Management Service saved card (PLAN 3.16). Visa returns a customer token when an authorization
 * asks for TOKEN_CREATE; the card itself stays in Visa's vault. The browser keeps only this server-signed
 * wrapper (customer id + masked number + expiry of the wrapper), so a guessed or copied customer id cannot be
 * charged through our checkout.
 */
export interface SavedCard { customerId: string; masked: string; iat: number }
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (secret: string, body: string) => createHmac("sha256", `lullabuy-saved-card:${secret}`).update(body).digest();

export function issueSavedCard(secret: string, c: Omit<SavedCard, "iat">, now = Date.now()): string {
  const body = b64u(JSON.stringify({ customerId: c.customerId, masked: c.masked.slice(-8), iat: now }));
  return `${body}.${b64u(mac(secret, body))}`;
}

export function verifySavedCard(secret: string, token: unknown, now = Date.now()): SavedCard | null {
  if (typeof token !== "string" || token.length > 600) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const got = Buffer.from(sig, "base64url"), want = mac(secret, body);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString()) as SavedCard;
    if (typeof c.customerId !== "string" || !/^[0-9A-F]{16,40}$/i.test(c.customerId) || typeof c.iat !== "number") return null;
    if (now - c.iat > TTL_MS || c.iat > now + 60_000) return null;
    return c;
  } catch {
    return null;
  }
}
