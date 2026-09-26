import type { Db } from "mongodb";
import { getDb } from "@/server/db/mongo";
import { speakText } from "@/server/voice/elevenlabs";
import { recallCallConfig, signTicket, type RecallCallConfig } from "./config";
import { buildNcco, callScript, reasonKey, type CallReason } from "./ncco";
import { openPhone } from "./phone";
import { claimCall, dayKey, ensureIndexes, getOptIn, takeSlot, updateCall } from "./store";
import { placeCall } from "./vonage";

/**
 * The recall call (PLAN 6.12). Runs in the background (waitUntil) AFTER the settlement is recorded, so it can never
 * delay or change what Visa did. Order of the gates, each failing closed:
 *   opted in on THIS deal -> claim (deal, reason) once -> daily cap -> per-number cap -> place the call.
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
    if (!db) return { state: "no-db" };
    const now = deps.now ?? Date.now();
    const fetchImpl = deps.fetchImpl ?? fetch;
    void ensureIndexes(db).catch(() => {});

    const opt = await getOptIn(db, dealId);
    if (!opt) return { state: "no-optin" };
    const to = openPhone(cfg.secret, opt.sealed);
    if (!to) return { state: "bad-optin" };
    const key = reasonKey(reason);
    const id = `${dealId}:${key}`;
    if (!(await claimCall(db, { dealId, reason: key, last4: opt.last4, hash: opt.hash }, now))) return { state: "already" };
    const day = dayKey(now);
    if (!(await takeSlot(db, `day:${day}`, cfg.dailyCap, now))) {
      await updateCall(db, id, { status: "capped", note: "daily call cap reached" });
      return { state: "capped-daily" };
    }
    if (!(await takeSlot(db, `num:${opt.hash}:${day}`, cfg.perNumberCap, now))) {
      await updateCall(db, id, { status: "capped", note: "this number already got its calls today" });
      return { state: "capped-number" };
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
