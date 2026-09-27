import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { Db } from "mongodb";
import { isTeamNumber, perNumberCapFor, TEAM_VERIFY_CALLS_PER_NUMBER, type RecallCallConfig } from "./config";
import { last4, phoneHash, sealPhone } from "./phone";
import { dayKey, dropVerification, reserveSlots, saveOptIn, startVerification, takeAttempt } from "./store";
import { placeCall } from "./vonage";

/**
 * Proof of phone control before an opt-in becomes active (a deal token proves the deal, not the phone). The opt-in
 * places a short call that speaks a 4-digit code twice; only the person holding that phone can type it back.
 * The code call spends the same per-number and daily caps as a recall call, plus its own cap (4 code calls per number
 * per day), and at most one code is in flight per deal, so the check itself cannot be used to ring someone repeatedly.
 */
export const VERIFY_CALLS_PER_NUMBER = 4;

const codeHash = (secret: string, dealId: string, numberHash: string, code: string) =>
  createHmac("sha256", `recall-call-code:${secret}`).update(`${dealId}|${numberHash}|${code}`).digest("hex");

export const spokenCode = (code: string) => code.split("").join(", ");

export function codeNcco(code: string) {
  const c = spokenCode(code);
  return [{ action: "talk" as const, text: `Your Lullabuy code is ${c}. Again, your code is ${c}. Goodbye.`, language: "en-US" }];
}

export type StartOutcome = "calling" | "in-flight" | "capped-verify" | "capped-number" | "capped-daily" | "failed" | "no-db";

export async function startCodeCall(db: Db, cfg: RecallCallConfig, dealId: string, phone: string,
  o: { fetchImpl?: typeof fetch; now?: number; code?: string } = {}): Promise<{ state: StartOutcome; error?: string }> {
  const now = o.now ?? Date.now();
  const code = o.code ?? String(randomInt(0, 10_000)).padStart(4, "0");
  const hash = phoneHash(cfg.secret, phone);
  const started = await startVerification(db, { _id: dealId, sealed: sealPhone(cfg.secret, phone), hash, last4: last4(phone), codeHash: codeHash(cfg.secret, dealId, hash, code) }, now);
  if (started === "in-flight") return { state: "in-flight" };
  if (started === "error") return { state: "no-db" };
  const day = dayKey(now);
  const r = await reserveSlots(db, [
    { id: `vnum:${hash}:${day}`, cap: isTeamNumber(cfg, hash) ? TEAM_VERIFY_CALLS_PER_NUMBER : VERIFY_CALLS_PER_NUMBER },
    { id: `num:${hash}:${day}`, cap: perNumberCapFor(cfg, hash) }, { id: `day:${day}`, cap: cfg.dailyCap },
  ], now);
  if (!r.ok) {
    await dropVerification(db, dealId);
    return { state: (["capped-verify", "capped-number", "capped-daily"] as const)[r.refused] };
  }
  const placed = await placeCall({ applicationId: cfg.applicationId, privateKey: cfg.privateKey, to: phone, from: cfg.from, ncco: codeNcco(code),
    eventUrl: `${cfg.baseUrl}/api/recall-call/event` }, o.fetchImpl);
  if (!placed.ok) {
    // the slots stay spent (the phone may have rung); the deal may try again
    await dropVerification(db, dealId);
    return { state: "failed", error: placed.error };
  }
  return { state: "calling" };
}

export type CheckOutcome = "verified" | "wrong" | "expired" | "no-db";

/** One attempt (of 3) at the code for this deal; on success the opt-in becomes active for the number that was called. */
export async function checkCode(db: Db, cfg: RecallCallConfig, dealId: string, code: unknown, now = Date.now()): Promise<{ state: CheckOutcome; last4?: string }> {
  if (typeof code !== "string" || !/^\d{4}$/.test(code.trim())) return { state: "wrong" };
  const v = await takeAttempt(db, dealId, now);
  if (!v) return { state: "expired" };
  const want = Buffer.from(v.codeHash, "hex"), got = Buffer.from(codeHash(cfg.secret, dealId, v.hash, code.trim()), "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { state: "wrong" };
  if (!(await saveOptIn(db, { _id: dealId, sealed: v.sealed, hash: v.hash, last4: v.last4 }, now))) return { state: "no-db" };
  await dropVerification(db, dealId);
  return { state: "verified", last4: v.last4 };
}
