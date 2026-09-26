import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import { getDb } from "@/server/db/mongo";

/**
 * One settlement per deal. The pickup token is reusable for its 12 h life, so two devices (the buyer's phone and
 * the table kiosk) can send it at the same moment, one with a clean label and one with a recalled one. Before any
 * Visa call, POST /api/pickup claims the deal in MongoDB Atlas (`settle_claims`, `_id` = dealId, created with an
 * atomic insert): exactly one request calls Visa, and every other request, concurrent or later, gets that
 * request's stored answer instead of calling Visa again.
 *
 * A claim whose holder died (crashed function, timeout) expires after CLAIM_TTL_MS and can be taken over, so a
 * hold is never locked forever; the takeover's Visa call is then refused by Visa if the dead request had already
 * settled it. When Atlas is not configured or not reachable, the claim is skipped and logged: Visa stays the
 * source of truth and itself refuses a second settlement of one authorization (MISSING_AUTH), which is exactly
 * the behaviour before claims existed.
 */

export const CLAIM_TTL_MS = 2 * 60 * 1000;
export const WAIT_MS = 10_000;
const POLL_MS = 400;

export interface Claim<R> { _id: string; by: string; at: number; expiresAt: number; result?: R }

/** The atomic operations a claim needs. Mongo in production; an in-memory store in tests. */
export interface ClaimStore<R> {
  /** true when this call created the claim; false when one already exists */
  insert(c: Claim<R>): Promise<boolean>;
  get(id: string): Promise<Claim<R> | null>;
  /** replaces an expired, unfinished claim held by `prevBy`; true when this call won it */
  takeOver(id: string, prevBy: string, now: number, next: Claim<R>): Promise<boolean>;
  finish(id: string, by: string, result: R): Promise<void>;
}

export type Outcome<R> =
  | { kind: "ran"; result: R }
  | { kind: "replayed"; result: R }
  | { kind: "busy" }
  | { kind: "unclaimed"; result: R };

export interface ClaimOpts<R> {
  store: ClaimStore<R> | null;
  /** false for a scan that moves no money (NEEDS_CHECK, UNREADABLE): it never takes a claim, but it still returns
   *  a settlement that already happened, and waits for one in progress */
  claim: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  requestId?: string;
  log?: (msg: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export async function settleOnce<R>(dealId: string, run: () => Promise<R>, o: ClaimOpts<R>): Promise<Outcome<R>> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const log = o.log ?? ((m: string) => console.warn(m));
  const by = o.requestId ?? randomUUID();
  const store = o.store;
  if (!store) {
    log(`[claims] no claim store for ${dealId}: settling without a claim (Visa refuses a second settlement)`);
    return { kind: "unclaimed", result: await run() };
  }
  // decide first, run after: a Visa call must never sit inside the catch below, or a store error after it would
  // run it a second time
  let action: "claimed" | "free" | Outcome<R>;
  try {
    action = await decide();
  } catch (e) {
    log(`[claims] claim store failed for ${dealId} (${(e as Error).message}): settling without a claim (Visa refuses a second settlement)`);
    return { kind: "unclaimed", result: await run() };
  }
  if (typeof action !== "string") return action;
  if (action === "free") return { kind: "ran", result: await run() };

  async function decide(): Promise<"claimed" | "free" | Outcome<R>> {
    const deadline = now() + WAIT_MS;
    for (;;) {
      const t = now();
      const fresh: Claim<R> = { _id: dealId, by, at: t, expiresAt: t + CLAIM_TTL_MS };
      if (o.claim && (await store!.insert(fresh))) return "claimed";
      const cur = await store!.get(dealId);
      if (cur?.result !== undefined) return { kind: "replayed", result: cur.result };
      if (!cur) {
        if (!o.claim) return "free"; // nothing settled or settling: a no-money scan runs
        continue; // the claim vanished between insert and read: try again
      }
      if (cur.expiresAt <= t) {
        if (!o.claim) return "free"; // the holder died: nothing is settling any more
        if (await store!.takeOver(dealId, cur.by, t, fresh)) { log(`[claims] ${dealId}: took over an expired claim`); return "claimed"; }
        continue;
      }
      if (now() >= deadline) return { kind: "busy" };
      await sleep(POLL_MS);
    }
  }
  const result = await run();
  try {
    await store.finish(dealId, by, result);
  } catch (e) {
    log(`[claims] could not store the result for ${dealId} (${(e as Error).message}); the claim expires in ${CLAIM_TTL_MS / 1000} s`);
  }
  return { kind: "ran", result };
}

/** A hard deadline on every store call: a hung Atlas becomes an error (and the unclaimed path), never a hang. */
function within<T>(p: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, bad) => { timer = setTimeout(() => bad(new Error(`timed out after ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(timer));
}

/** The Atlas store, or null when Atlas is not configured. */
export async function mongoClaims<R>(): Promise<ClaimStore<R> | null> {
  let c: Collection<Claim<R>>;
  try {
    const db = await within(getDb());
    if (!db) return null;
    c = db.collection<Claim<R>>("settle_claims");
  } catch (e) {
    console.warn(`[claims] Atlas not reachable (${(e as Error).message})`);
    return null;
  }
  return {
    async insert(doc) {
      try {
        await within(c.insertOne(doc as never));
        return true;
      } catch (e) {
        if ((e as { code?: number }).code === 11000) return false; // duplicate key: someone holds or finished it
        throw e;
      }
    },
    get: (id) => within(c.findOne({ _id: id } as never)) as Promise<Claim<R> | null>,
    async takeOver(id, prevBy, t, next) {
      const r = await within(c.findOneAndUpdate({ _id: id, by: prevBy, result: { $exists: false }, expiresAt: { $lte: t } } as never,
        { $set: { by: next.by, at: next.at, expiresAt: next.expiresAt } }));
      return !!r;
    },
    async finish(id, by, result) {
      await within(c.updateOne({ _id: id, by } as never, { $set: { result } } as never));
    },
  };
}

/** In-memory store with the same atomicity (single-threaded), for tests. */
export function memoryClaims<R>(): ClaimStore<R> & { docs: Map<string, Claim<R>> } {
  const docs = new Map<string, Claim<R>>();
  return {
    docs,
    async insert(c) { if (docs.has(c._id)) return false; docs.set(c._id, { ...c }); return true; },
    async get(id) { const d = docs.get(id); return d ? { ...d } : null; },
    async takeOver(id, prevBy, t, next) {
      const d = docs.get(id);
      if (!d || d.by !== prevBy || d.result !== undefined || d.expiresAt > t) return false;
      docs.set(id, { ...d, by: next.by, at: next.at, expiresAt: next.expiresAt });
      return true;
    },
    async finish(id, by, result) { const d = docs.get(id); if (d && d.by === by) d.result = result; },
  };
}
