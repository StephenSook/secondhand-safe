import type { Db } from "mongodb";
import { getDb } from "@/server/db/mongo";
import { speakText } from "@/server/voice/elevenlabs";
import { recallCallConfig, signTicket, type RecallCallConfig } from "./config";
import { buildNcco, callScript, reasonKey, type CallReason } from "./ncco";
import { openPhone } from "./phone";
import { claimCall, dayKey, enqueueCall, ensureIndexes, getOptIn, pendingCalls, reserveSlots, updateCall } from "./store";
import { placeCall } from "./vonage";

/**
 * The recall call (PLAN 6.12). Runs in the background AFTER the settlement is recorded, so it can never delay or
 * change what Visa did. Order of the gates, each failing closed:
 *   TTL indexes -> a VERIFIED opt-in on THIS deal -> claim (deal, reason) once -> per-number cap, then daily cap
 *   (reserved together: a refused number gives back nothing it took) -> place the call.
 * A slot is spent even when the call later fails: a failure is never retried into a second call.
 */
export type CallOutcome =
  | { state: "not-configured" | "no-db" | "no-optin" | "already" | "capped-daily" | "capped-number" | "bad-optin" }
  | { state: "placed"; mode: "stream" | "talk"; uuid: string }
  | { state: "failed"; error: string };

export interface CallDeps {
  db?: Db | null; cfg?: RecallCallConfig | null; fetchImpl?: typeof fetch; elevenKey?: string | null; now?: number;
}

const ttsWithin = async (text: string, key: string, fetchImpl: typeof fetch, ms: number): Promise<Buffer | null> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    const audio = await Promise.race([speakText(text, "en", key, fetchImpl), new Promise<null>((ok) => { t = setTimeout(() => ok(null), ms); })]);
    return audio && audio.byteLength > 1000 ? Buffer.from(audio) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
};

export async function recallCall(dealId: string, reason: CallReason, deps: CallDeps = {}): Promise<CallOutcome> {
  try {
    const cfg = deps.cfg !== undefined ? deps.cfg : recallCallConfig();
    if (!cfg) return { state: "not-configured" };
    const db = deps.db !== undefined ? deps.db : await getDb().catch(() => null);
    if (!db || !(await ensureIndexes(db))) return { state: "no-db" };
    const now = deps.now ?? Date.now();
    const fetchImpl = deps.fetchImpl ?? fetch;

    const opt = await getOptIn(db, dealId);
    if (!opt) return { state: "no-optin" };
    const to = openPhone(cfg.secret, opt.sealed);
    if (!to) return { state: "bad-optin" };
    const key = reasonKey(reason);
    const id = `${dealId}:${key}`;
    if (!(await claimCall(db, { dealId, reason: key, recallNumber: reason.recallNumber, last4: opt.last4, hash: opt.hash }, now))) return { state: "already" };
    const day = dayKey(now);
    const r0 = await reserveSlots(db, [{ id: `num:${opt.hash}:${day}`, cap: cfg.perNumberCap }, { id: `day:${day}`, cap: cfg.dailyCap }], now);
    if (!r0.ok) {
      const numberCapped = r0.refused === 0;
      await updateCall(db, id, { status: "capped", note: numberCapped ? "this number already got its calls today" : "daily call cap reached" });
      return { state: numberCapped ? "capped-number" : "capped-daily" };
    }

    const deal = await db.collection<{ _id: string; listing: string; amountUsd: number }>("deals")
      .findOne({ _id: dealId }, { projection: { listing: 1, amountUsd: 1 }, maxTimeMS: 4000 }).catch(() => null);
    const text = callScript(reason, { listing: deal?.listing ?? "", amountUsd: deal?.amountUsd ?? Number.NaN });
    const eleven = deps.elevenKey !== undefined ? deps.elevenKey : process.env.ELEVENLABS_API_KEY?.trim() || null;
    const audio = eleven ? await ttsWithin(text, eleven, fetchImpl, 8000) : null;
    const mode = audio ? "stream" : "talk";
    await updateCall(db, id, { status: "placing", mode, text, audio });

    const t = (p: "audio" | "input" | "event", n?: number) => encodeURIComponent(signTicket(cfg.secret, { k: id, p, ...(n !== undefined ? { n } : {}) }, 30 * 60_000, now));
    const base = `${cfg.baseUrl}/api/recall-call`;
    const ncco = buildNcco({ text, audioUrl: audio ? `${base}/audio?c=${t("audio")}` : null, inputUrl: `${base}/input?c=${t("input", 0)}`, replays: 0 });
    const r = await placeCall({ applicationId: cfg.applicationId, privateKey: cfg.privateKey, to, from: cfg.from, ncco, eventUrl: `${base}/event?c=${t("event")}` }, fetchImpl);
    if (!r.ok) {
      await updateCall(db, id, { status: "failed", note: r.error.slice(0, 200) });
      return { state: "failed", error: r.error };
    }
    const at = new Date(now).toISOString();
    await updateCall(db, id, { status: "placed", uuid: r.uuid, placedAt: at });
    // the PUBLIC timeline says that a call was placed, never to which number (the buyer's own page shows the last 4)
    await db.collection<{ _id: string }>("deals").updateOne({ _id: dealId }, { $set: { updatedAt: at },
      $push: { events: { at, status: reason.kind === "reversed" ? "REVERSED" : "CAPTURED", note: "Lullabuy phoned the buyer, who opted in, with this result" } } } as never)
      .catch(() => {});
    return { state: "placed", mode, uuid: r.uuid };
  } catch (e) {
    console.warn("[recall-call] failed:", (e as Error).message);
    return { state: "failed", error: (e as Error).message };
  }
}

/** The longest one call can take: 8 s of ElevenLabs plus 10 s of Vonage, plus the database writes. */
export const CALL_MAX_MS = 22_000;

/** The recall watch queues a post-sale call for a VERIFIED opt-in (idempotent); true when newly queued. */
export async function queueRecallCall(dealId: string, recallNumber: string, deps: Pick<CallDeps, "db" | "cfg"> = {}): Promise<boolean> {
  const cfg = deps.cfg !== undefined ? deps.cfg : recallCallConfig();
  const db = deps.db !== undefined ? deps.db : await getDb().catch(() => null);
  if (!cfg || !db) return false;
  const opt = await getOptIn(db, dealId);
  if (!opt) return false;
  return enqueueCall(db, { dealId, reason: reasonKey({ kind: "postsale", recallNumber }), recallNumber, last4: opt.last4, hash: opt.hash });
}

/**
 * Runs the recall watch's QUEUED calls (this run's and any left over from earlier runs) in parallel, and stops
 * waiting at `deadlineMs`. A call that has not started by then stays "pending" and is picked up by the next run;
 * one that started is never started again (its claim moved to "claimed").
 */
export async function runPendingCalls(deadlineMs: number, deps: CallDeps = {}): Promise<{ started: number; outcomes: string[]; timedOut: boolean }> {
  const db = deps.db !== undefined ? deps.db : await getDb().catch(() => null);
  if (!db) return { started: 0, outcomes: [], timedOut: false };
  const queued = (await pendingCalls(db)).filter((c) => c.reason.startsWith("postsale:") && c.recallNumber);
  const left = deadlineMs - Date.now();
  // start nothing that could still be running when the function is stopped: it would be claimed and never retried
  if (!queued.length || left < CALL_MAX_MS) return { started: 0, outcomes: [], timedOut: queued.length > 0 };
  const outcomes: string[] = [];
  const all = Promise.allSettled(queued.map(async (c) => {
    const o = await recallCall(c.dealId, { kind: "postsale", recallNumber: c.recallNumber! }, { ...deps, db });
    outcomes.push(o.state);
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([all.then(() => false), new Promise<boolean>((ok) => { timer = setTimeout(() => ok(true), left); })]);
  clearTimeout(timer);
  return { started: queued.length, outcomes: [...outcomes], timedOut };
}
