import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Deal token: binds dealId + Visa authorization id + amount at checkout, so /api/pickup can only settle the
 * hold it was issued for, for exactly that amount. Keyed from DEAL_TOKEN_SECRET when set (so rotating the Visa
 * key does not orphan open holds), otherwise derived from the Visa secret. Never sent to the client.
 */
export interface DealClaims { dealId: string; authId: string; amountUsd: number; iat: number }

export const TTL_MS = 12 * 60 * 60 * 1000;
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Signing key first; the derived key is also accepted so setting DEAL_TOKEN_SECRET never orphans open holds. */
function keys(secret: string): string[] {
  const derived = `shs-deal:${secret}`;
  const explicit = process.env.DEAL_TOKEN_SECRET?.trim();
  return explicit ? [explicit, derived] : [derived];
}

function mac(key: string, body: string) {
  return createHmac("sha256", key).update(body).digest();
}

export function issueDealToken(secret: string, c: Omit<DealClaims, "iat">, now = Date.now()): string {
  const body = b64u(JSON.stringify({ ...c, amountUsd: Number(c.amountUsd.toFixed(2)), iat: now }));
  return `${body}.${b64u(mac(keys(secret)[0], body))}`;
}

export function verifyDealToken(secret: string, token: string, now = Date.now()): DealClaims | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const got = Buffer.from(sig, "base64url");
  const valid = keys(secret).some((k) => {
    const expected = mac(k, body);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!valid) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString()) as DealClaims;
    if (typeof c.dealId !== "string" || typeof c.authId !== "string" || typeof c.amountUsd !== "number") return null;
    if (now - c.iat > TTL_MS || c.iat > now + 60_000) return null;
    return c;
  } catch {
    return null;
  }
}
