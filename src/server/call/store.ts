import type { Db } from "mongodb";

/**
 * Atlas state for the recall call. Three collections, none of them the public `deals` collection:
 *  - recall_optins  { _id: dealId }: the sealed number bound to ONE deal (by its token, server side), with a TTL;
 *  - recall_calls   { _id: "<dealId>:<reason>" }: the claim; inserting it is what makes a call happen at most once;
 *  - recall_call_counters { _id: "day:<date>" | "num:<hash>:<date>" }: the daily and per-number caps.
 * Every function fails CLOSED: a database error means "no call", never "call anyway".
 */
export const OPTIN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const COUNTER_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export interface OptIn { _id: string; sealed: string; hash: string; last4: string; createdAt: string; expireAt: Date }
export type CallStatus = "claimed" | "capped" | "placing" | "placed" | "failed" | "answered" | "completed" | "unanswered";
export interface CallDoc {
  _id: string; dealId: string; reason: string; last4: string; hash: string; status: CallStatus; note?: string;
  mode?: "stream" | "talk"; uuid?: string; text?: string; audio?: Buffer | { buffer: Buffer } | null;
  createdAt: string; updatedAt: string; placedAt?: string; expireAt: Date;
}
interface Counter { _id: string; n: number; expireAt: Date }

const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;

let indexed = false;
/** TTL indexes (best effort, once per instance). */
export async function ensureIndexes(db: Db) {
  if (indexed) return;
  indexed = true;
  await Promise.all(["recall_optins", "recall_calls", "recall_call_counters"].map((c) =>
    db.collection(c).createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {})));
}

export async function saveOptIn(db: Db, o: Omit<OptIn, "createdAt" | "expireAt">, now = Date.now()): Promise<boolean> {
  try {
    await db.collection<OptIn>("recall_optins").updateOne({ _id: o._id },
      { $set: { sealed: o.sealed, hash: o.hash, last4: o.last4, createdAt: new Date(now).toISOString(), expireAt: new Date(now + OPTIN_TTL_MS) } },
      { upsert: true });
    return true;
  } catch {
    return false;
  }
}

export async function getOptIn(db: Db, dealId: string): Promise<OptIn | null> {
  try {
    const o = await db.collection<OptIn>("recall_optins").findOne({ _id: dealId }, { maxTimeMS: 4000 });
    return o && o.expireAt.getTime() > Date.now() ? o : null;
  } catch {
    return null;
  }
}

/** True for exactly one caller per (deal, reason), however many race. */
export async function claimCall(db: Db, d: { dealId: string; reason: string; last4: string; hash: string }, now = Date.now()): Promise<boolean> {
  const at = new Date(now).toISOString();
  try {
    await db.collection<CallDoc>("recall_calls").insertOne({ _id: `${d.dealId}:${d.reason}`, dealId: d.dealId, reason: d.reason, last4: d.last4, hash: d.hash,
      status: "claimed", createdAt: at, updatedAt: at, expireAt: new Date(now + OPTIN_TTL_MS) });
    return true;
  } catch (e) {
    if (!isDup(e)) console.warn("[recall-call] claim failed:", (e as Error).message);
    return false;
  }
}

/**
 * Takes one slot of a counter capped at `cap`, atomically: the filter only matches while n < cap, so at the cap the
 * upsert tries to insert a second document with the same _id and Atlas refuses it (duplicate key) -> false.
 */
export async function takeSlot(db: Db, id: string, cap: number, now = Date.now()): Promise<boolean> {
  if (cap <= 0) return false;
  try {
    const r = await db.collection<Counter>("recall_call_counters").updateOne({ _id: id, n: { $lt: cap } },
      { $inc: { n: 1 }, $setOnInsert: { expireAt: new Date(now + COUNTER_TTL_MS) } }, { upsert: true });
    return r.modifiedCount === 1 || r.upsertedCount === 1;
  } catch (e) {
    if (!isDup(e)) console.warn("[recall-call] cap check failed:", (e as Error).message);
    return false;
  }
}

export async function updateCall(db: Db, id: string, set: Partial<Omit<CallDoc, "_id">>, onlyIf?: CallStatus[]): Promise<boolean> {
  try {
    const r = await db.collection<CallDoc>("recall_calls").updateOne(onlyIf ? { _id: id, status: { $in: onlyIf } } : { _id: id },
      { $set: { ...set, updatedAt: new Date().toISOString() } });
    return r.matchedCount === 1;
  } catch {
    return false;
  }
}

export async function getCall(db: Db, id: string, withAudio = false): Promise<CallDoc | null> {
  try {
    return await db.collection<CallDoc>("recall_calls").findOne({ _id: id }, { maxTimeMS: 4000, ...(withAudio ? {} : { projection: { audio: 0 } }) });
  } catch {
    return null;
  }
}

export async function callsForDeal(db: Db, dealId: string): Promise<CallDoc[] | null> {
  try {
    return await db.collection<CallDoc>("recall_calls").find({ dealId }, { projection: { audio: 0, text: 0, hash: 0 }, maxTimeMS: 4000, limit: 10 }).toArray();
  } catch {
    return null;
  }
}

export const dayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
