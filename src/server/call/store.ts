import type { Db } from "mongodb";

/**
 * Atlas state for the recall call. Four collections, none of them the public `deals` collection:
 *  - recall_verifications { _id: dealId }: a 4-digit code (hashed) spoken to a number, 10 min, 3 attempts;
 *  - recall_optins  { _id: dealId }: the sealed number, ACTIVE only after its code was entered, with a TTL;
 *  - recall_calls   { _id: "<dealId>:<reason>" }: the claim; it makes a call happen at most once
 *    (status "pending" = queued by the recall watch, not yet started; the only state that is ever retried);
 *  - recall_call_counters { _id: "day:<date>" | "num:<hash>:<date>" | "vnum:<hash>:<date>" }: the caps.
 * Every function fails CLOSED: a database error means "no call" and "no phone write", never "anyway".
 */
export const OPTIN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const VERIFY_TTL_MS = 10 * 60_000;
export const VERIFY_ATTEMPTS = 3;
const COUNTER_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export interface OptIn { _id: string; sealed: string; hash: string; last4: string; createdAt: string; expireAt: Date }
export interface Verification { _id: string; sealed: string; hash: string; last4: string; codeHash: string; attempts: number; exp: number; expireAt: Date }
export type CallStatus = "pending" | "claimed" | "capped" | "placing" | "placed" | "failed" | "answered" | "completed" | "unanswered";
export interface CallDoc {
  _id: string; dealId: string; reason: string; recallNumber?: string | null; last4: string; hash: string; status: CallStatus; note?: string;
  mode?: "stream" | "talk"; uuid?: string; text?: string; audio?: Buffer | { buffer: Buffer } | null;
  createdAt: string; updatedAt: string; placedAt?: string; expireAt: Date;
}
interface Counter { _id: string; n: number; expireAt: Date }

const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;

export const PHONE_COLLECTIONS = ["recall_verifications", "recall_optins", "recall_calls", "recall_call_counters"] as const;
const indexed = new WeakSet<Db>();
/**
 * The TTL indexes that make phone data expire. Awaited before ANY phone write; the database is only marked ready
 * once every index was created (createIndex is a no-op when it already exists), so a failure is retried next time.
 */
export async function ensureIndexes(db: Db): Promise<boolean> {
  if (indexed.has(db)) return true;
  try {
    await Promise.all(PHONE_COLLECTIONS.map((c) => db.collection(c).createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, name: "expireAt_ttl" })));
    indexed.add(db);
    return true;
  } catch (e) {
    console.warn("[recall-call] TTL indexes could not be created; refusing phone writes:", (e as Error).message);
    return false;
  }
}

/** Starts a code check for this deal, unless one is still in flight (at most one per deal). */
export async function startVerification(db: Db, v: Omit<Verification, "attempts" | "exp" | "expireAt">, now = Date.now()): Promise<"ok" | "in-flight" | "error"> {
  if (!(await ensureIndexes(db))) return "error";
  try {
    // matches only an EXPIRED check; a live one makes the upsert collide on _id and is refused
    await db.collection<Verification>("recall_verifications").updateOne({ _id: v._id, exp: { $lt: now } },
      { $set: { sealed: v.sealed, hash: v.hash, last4: v.last4, codeHash: v.codeHash, attempts: 0, exp: now + VERIFY_TTL_MS, expireAt: new Date(now + VERIFY_TTL_MS) } },
      { upsert: true });
    return "ok";
  } catch (e) {
    return isDup(e) ? "in-flight" : "error";
  }
}

export async function dropVerification(db: Db, dealId: string) {
  await db.collection<Verification>("recall_verifications").deleteOne({ _id: dealId }).catch(() => {});
}

/** Spends one attempt atomically; null when there is no live check left to try. */
export async function takeAttempt(db: Db, dealId: string, now = Date.now()): Promise<Verification | null> {
  try {
    const r = await db.collection<Verification>("recall_verifications").findOneAndUpdate(
      { _id: dealId, exp: { $gt: now }, attempts: { $lt: VERIFY_ATTEMPTS } }, { $inc: { attempts: 1 } }, { returnDocument: "after" });
    return r ?? null;
  } catch {
    return null;
  }
}

export async function getVerification(db: Db, dealId: string, now = Date.now()): Promise<Verification | null> {
  try {
    const v = await db.collection<Verification>("recall_verifications").findOne({ _id: dealId }, { maxTimeMS: 4000 });
    return v && v.exp > now ? v : null;
  } catch {
    return null;
  }
}

export async function saveOptIn(db: Db, o: Omit<OptIn, "createdAt" | "expireAt">, now = Date.now()): Promise<boolean> {
  if (!(await ensureIndexes(db))) return false;
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

/**
 * True for exactly one caller per (deal, reason), however many race: either it inserts the claim, or it moves a
 * QUEUED ("pending") claim to "claimed". A claim that already started is never taken again.
 */
export async function claimCall(db: Db, d: { dealId: string; reason: string; recallNumber?: string | null; last4: string; hash: string }, now = Date.now()): Promise<boolean> {
  const at = new Date(now).toISOString();
  const col = db.collection<CallDoc>("recall_calls");
  try {
    await col.insertOne({ _id: `${d.dealId}:${d.reason}`, dealId: d.dealId, reason: d.reason, recallNumber: d.recallNumber ?? null, last4: d.last4, hash: d.hash,
      status: "claimed", createdAt: at, updatedAt: at, expireAt: new Date(now + OPTIN_TTL_MS) });
    return true;
  } catch (e) {
    if (!isDup(e)) { console.warn("[recall-call] claim failed:", (e as Error).message); return false; }
  }
  try {
    const r = await col.updateOne({ _id: `${d.dealId}:${d.reason}`, status: "pending" }, { $set: { status: "claimed", updatedAt: at } });
    return r.modifiedCount === 1;
  } catch {
    return false;
  }
}

/** Queues a call (recall watch): idempotent; true when newly queued. Needs an active opt-in. */
export async function enqueueCall(db: Db, d: { dealId: string; reason: string; recallNumber: string; last4: string; hash: string }, now = Date.now()): Promise<boolean> {
  if (!(await ensureIndexes(db))) return false;
  const at = new Date(now).toISOString();
  try {
    await db.collection<CallDoc>("recall_calls").insertOne({ _id: `${d.dealId}:${d.reason}`, dealId: d.dealId, reason: d.reason, recallNumber: d.recallNumber,
      last4: d.last4, hash: d.hash, status: "pending", createdAt: at, updatedAt: at, expireAt: new Date(now + OPTIN_TTL_MS) });
    return true;
  } catch {
    return false;
  }
}

export async function pendingCalls(db: Db, limit = 25): Promise<CallDoc[]> {
  try {
    return await db.collection<CallDoc>("recall_calls").find({ status: "pending" }, { projection: { audio: 0 }, sort: { createdAt: 1 }, limit, maxTimeMS: 4000 }).toArray();
  } catch {
    return [];
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

/** Gives back a slot taken by takeSlot (used when a LATER cap refuses, so a refused call spends nothing). */
export async function releaseSlot(db: Db, id: string): Promise<void> {
  await db.collection<Counter>("recall_call_counters").updateOne({ _id: id, n: { $gt: 0 } }, { $inc: { n: -1 } }).catch(() => {});
}

/**
 * Reserves every counter in order (most specific first) or none: when one refuses, the ones already taken are
 * released, so a number at its cap never spends the shared daily budget. Returns the index of the refusing cap.
 */
export async function reserveSlots(db: Db, slots: { id: string; cap: number }[], now = Date.now()): Promise<{ ok: true } | { ok: false; refused: number }> {
  const taken: string[] = [];
  for (const [i, s] of slots.entries()) {
    if (!(await takeSlot(db, s.id, s.cap, now))) {
      for (const t of taken.reverse()) await releaseSlot(db, t);
      return { ok: false, refused: i };
    }
    taken.push(s.id);
  }
  return { ok: true };
}

export async function counter(db: Db, id: string): Promise<number> {
  const c = await db.collection<Counter>("recall_call_counters").findOne({ _id: id }).catch(() => null);
  return c?.n ?? 0;
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
