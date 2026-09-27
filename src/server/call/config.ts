import { createHmac, timingSafeEqual } from "node:crypto";
import { INTEGRATIONS } from "@/server/env";
import { parseUsPhone } from "./phone";

/**
 * The recall call is live only when every variable it needs is present (wired-or-cut): the Vonage application id and
 * its private key, the caller-id number, the secret that seals opted-in numbers, the public base URL Vonage fetches
 * the audio from, and MongoDB Atlas (claims and caps live there, and fail closed without it).
 */
export interface RecallCallConfig {
  applicationId: string; privateKey: string; from: string; secret: string; baseUrl: string; dailyCap: number; perNumberCap: number;
}

/** Recall and code calls one number can receive per UTC day, across every deal (the daily cap still bounds the whole deployment). */
export const PER_NUMBER_DAILY_CAP = 6;

/** A PEM pasted into an env var often arrives with literal "\n" escapes, or base64-encoded; accept both. */
export function normalizePem(raw: string): string {
  const s = raw.trim();
  if (s.includes("-----BEGIN")) return s.replace(/\\n/g, "\n").trim();
  try {
    const dec = Buffer.from(s, "base64").toString("utf8");
    return dec.includes("-----BEGIN") ? dec.trim() : s;
  } catch {
    return s;
  }
}

export function recallCallConfig(src: Record<string, string | undefined> = process.env): RecallCallConfig | null {
  const v = (k: string) => src[k]?.trim() || "";
  if (!INTEGRATIONS.recallCall.every((k) => v(k))) return null;
  const from = parseUsPhone(v("RECALL_CALL_FROM_NUMBER"));
  if (!from) return null;
  let baseUrl: string;
  try {
    const u = new URL(v("PUBLIC_BASE_URL"));
    if (u.protocol !== "https:") return null; // Vonage fetches the audio and posts events here
    baseUrl = u.origin;
  } catch {
    return null;
  }
  const cap = Number(v("RECALL_CALL_DAILY_CAP") || 60);
  return {
    applicationId: v("RECALL_CALL_VONAGE_APPLICATION_ID"), privateKey: normalizePem(v("RECALL_CALL_VONAGE_PRIVATE_KEY")),
    from, secret: v("RECALL_CALL_SECRET"), baseUrl,
    dailyCap: Number.isInteger(cap) && cap >= 0 ? Math.min(cap, 500) : 60, perNumberCap: PER_NUMBER_DAILY_CAP,
  };
}

/** Short-lived signed tokens for the URLs Vonage calls back (audio, DTMF input, events). */
export interface CallTicket { k: string; p: "audio" | "input" | "event"; n?: number; exp: number }

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const mac = (secret: string, body: string) => createHmac("sha256", `recall-call-ticket:${secret}`).update(body).digest();

export function signTicket(secret: string, t: Omit<CallTicket, "exp">, ttlMs = 30 * 60_000, now = Date.now()): string {
  const body = b64u(JSON.stringify({ ...t, exp: now + ttlMs }));
  return `${body}.${b64u(mac(secret, body))}`;
}

export function verifyTicket(secret: string, token: string | null, purpose: CallTicket["p"], now = Date.now()): CallTicket | null {
  if (!token || token.length > 600) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const got = Buffer.from(sig, "base64url"), want = mac(secret, body);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString()) as CallTicket;
    if (t.p !== purpose || typeof t.k !== "string" || typeof t.exp !== "number" || t.exp < now) return null;
    return t;
  } catch {
    return null;
  }
}
