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
 * It fails closed, with no retry machinery:
 * - no claim, no Visa call: when Atlas is not configured, not reachable or erroring, a settlement is refused
 *   before Visa ("unavailable"; nothing moved, the buyer can try again);
 * - a claim is never taken over: one older than CLAIM_TTL_MS with no stored result means an earlier attempt may
 *   have moved money, so the answer is "uncertain" (UNKNOWN), never a second Visa call. The deal record
 *   (recordSettlement) and Visa are where that outcome is confirmed;
 * - if the result cannot be stored after Visa answered, this caller still gets Visa's real answer, and later
 *   callers get "busy" and then "uncertain", never a made-up REFUSED;
 * - with no claim yet, the deal record is read before one is taken: a deal it already shows as final (settled
 *   before claims existed, or by the sweeper) is answered from it ("final"), never settled again.
 * A scan that moves no money (NEEDS_CHECK, UNREADABLE) never takes a claim and calls no Visa API, but it goes
 * through the same reads, so it never reports HELD over a settlement it could have seen.
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
  /** stores the result on the claim this request owns; true only when exactly that claim was updated */
  finish(id: string, by: string, result: R): Promise<boolean>;
}

export type Outcome<R> =
  | { kind: "ran"; result: R }
  | { kind: "replayed"; result: R }
  | { kind: "busy" } // another request holds the claim right now
  | { kind: "unavailable" } // no claim could be taken: Visa was not called
  | { kind: "uncertain" } // an earlier attempt's outcome was never stored: Visa was not called
  | { kind: "final"; status: string }; // the deal record already shows a final status: Visa was not called

export interface ClaimOpts<R> {
  store: ClaimStore<R> | null;
  /** false for a scan that moves no money: it takes no claim, but still returns a settlement that already
   *  happened, and waits for one in progress */
  claim: boolean;
  /** the deal record's status when it is final, else null; throws when the record cannot be read */
  finalStatus?: () => Promise<string | null>;
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

  // decide first, run after: run() is never inside the catch, so a store error can never repeat it
  let decision: "claimed" | "free" | Outcome<R>;
  try {
    decision = store ? await decide(store) : { kind: "unavailable" };
  } catch (e) {
    log(`[claims] claim store failed for ${dealId}: ${(e as Error).message}`);
    decision = { kind: "unavailable" };
  }
  if (decision === "free") return { kind: "ran", result: await run() }; // moves no money
  if (decision !== "claimed") {
    if (decision.kind === "unavailable") log(`[claims] deal state for ${dealId} not readable: nothing sent to Visa`);
    return decision;
  }
  const result = await run();
  let stored = false;
  try {
    stored = await store!.finish(dealId, by, result);
  } catch (e) {
    log(`[claims] result write failed for ${dealId}: ${(e as Error).message}`);
  }
  if (!stored) log(`[claims] result for ${dealId} not stored: later requests get busy, then UNKNOWN`);
  return { kind: "ran", result };

  async function decide(st: ClaimStore<R>): Promise<"claimed" | "free" | Outcome<R>> {
    const deadline = now() + WAIT_MS;
    for (;;) {
      const t = now();
      const cur = await st.get(dealId);
      if (cur?.result !== undefined) return { kind: "replayed", result: cur.result };
      if (cur && cur.expiresAt <= t) return { kind: "uncertain" };
      if (!cur) {
        const status = o.finalStatus ? await o.finalStatus() : null;
        if (status) return { kind: "final", status };
        if (!o.claim) return "free"; // nothing settled or settling
        if (await st.insert({ _id: dealId, by, at: t, expiresAt: t + CLAIM_TTL_MS })) return "claimed";
        if (t >= deadline) return { kind: "busy" };
        continue; // another request claimed it between the read and the insert: read again
      }
      if (t >= deadline) return { kind: "busy" };
      await sleep(POLL_MS);
    }
  }
}

/** A hard deadline on every store call: a hung Atlas becomes an error (and no Visa call), never a hang. */
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
    async finish(id, by, result) {
      const r = await within(c.updateOne({ _id: id, by, result: { $exists: false } } as never, { $set: { result } } as never));
      return r.modifiedCount === 1;
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
    async finish(id, by, result) {
      const d = docs.get(id);
      if (!d || d.by !== by || d.result !== undefined) return false;
      d.result = result;
      return true;
    },
  };
}
