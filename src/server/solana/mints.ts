import type { Umi } from "@metaplex-foundation/umi";
import { getDb } from "@/server/db/mongo";
import { recordPassportAsset } from "@/server/deals/store";
import { balanceRefusal, deadline, newAssetSigner, readPassportAsset, sendCreate, umiFromEnv, type PassportFields } from "./core";

/**
 * Minting the Metaplex Core passport (PLAN 6.4). The Memo passport is already written for every captured sale; the Core
 * asset is an add-on, so this is deliberately one attempt per deal with no retry engine.
 *
 * 1. Cap admission first: one conditional $inc on today's counter admits the request only while count < cap. An
 *    unreadable counter refuses (fail closed). Only an admitted request inserts the per-deal claim (_id = dealId, so
 *    concurrent pickups race on Atlas's unique _id and exactly one wins). PASSPORT_DAILY_CAP=0 switches minting off.
 * 2. One attempt, one address, ever: the asset address is stored as pending before the single send. A timeout is
 *    "uncertain"; the cron (and a view of that sale's passport page) only looks up that stored address: found = minted and linked, absent after SETTLE_AFTER_MS
 *    (far past blockhash expiry) = terminal not_minted. It never sends.
 * 3. The balance floor is a best-effort pre-check (floor + one mint). Concurrent mints for different deals can dip the
 *    wallet slightly below the floor; that is accepted on devnet, where SOL has no value.
 *
 * Known limit: a crash between storing the claim and sending leaves an address that never lands, so that sale ends as
 * not_minted with no Core asset. It keeps its verified Memo passport. The signer's secret key is never stored.
 */
export type MintState = "pending" | "uncertain" | "minted" | "not_minted" | "link_failed";
export interface MintClaim {
  _id: string; // dealId
  address: string; state: MintState; linked: boolean; fields: PassportFields; baseUrl: string;
  /** this claim passed today's cap; reconcile ignores any claim without it */
  admitted: true;
  /** when the single send was prepared; an absent asset is terminal only SETTLE_AFTER_MS after this */
  attemptAt: string;
  /** the cron looks at this claim no earlier than this */
  nextAttemptAt: string;
  linkAttempts: number;
  signature?: string | null; reason?: string | null; createdAt: string; updatedAt: string;
}
type Patch = Partial<Omit<MintClaim, "_id">>;

/** Everything the mint flow needs from storage; atlasMintStore() is the real one, tests pass a fake. */
export interface MintStore {
  /** atomically takes one of today's `cap` slots: "admitted", "over" (cap reached), or null (counter unreadable) */
  admit(day: string, cap: number): Promise<"admitted" | "over" | null>;
  /** "won" = this caller holds the deal's only claim; "lost" = someone already claimed it; null = store unavailable */
  claim(c: MintClaim): Promise<"won" | "lost" | null>;
  update(dealId: string, patch: Patch): Promise<boolean | null>;
  /** one deal's claim; "none" = no claim exists; null = store unreadable */
  get(dealId: string): Promise<MintClaim | "none" | null>;
  /** admitted claims due for work (nextAttemptAt <= now), soonest first: pending, uncertain, or minted but not linked */
  open(limit: number, nowIso: string): Promise<MintClaim[] | null>;
  /** takes one deal's claim if it is admitted, open and due (nextAttemptAt <= now), moving nextAttemptAt to `holdUntil`
   *  in the same conditional update; null = not due, not open, or unreadable */
  takeDue(dealId: string, nowIso: string, holdUntilIso: string): Promise<MintClaim | null>;
  /** links the asset address to the deal record; true when the deal now points at it */
  link(dealId: string, address: string): Promise<boolean | null>;
}

/** "0" turns minting off; an empty or mistyped setting falls back to 50. Read per call so the switch needs no redeploy. */
export function dailyCap(raw = process.env.PASSPORT_DAILY_CAP?.trim()) {
  const n = Number(raw);
  return raw === "0" ? 0 : Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
}
/** A Solana blockhash is valid for about 150 slots (60 to 90 s) and a pickup function runs at most 120 s, so an address
 *  still absent this long after its send was prepared can no longer land. */
export const SETTLE_AFTER_MS = 5 * 60_000;
export const MAX_LINK_ATTEMPTS = 5;
/** what one create may spend: measured about 0.0043 SOL on devnet (fee + rent), reserved with margin */
export const MINT_COST_LAMPORTS = 6_000_000n;
/** at most this many claims handled per reconcile run, whatever their branch */
export const RECONCILE_PER_RUN = 5;
/** a viewed passport looks at devnet for its claim at most this often */
export const VIEW_RECHECK_MS = 30_000;
/** claims that are still settling; the passport page keeps refreshing while it sees one */
export const MINT_IN_FLIGHT: readonly MintState[] = ["pending", "uncertain", "minted"];

const iso = (ms: number) => new Date(ms).toISOString();
/** admitted claims that still need work: pending, uncertain, or minted but not linked */
const OPEN = { admitted: true as const, $or: [{ state: { $in: ["pending", "uncertain"] as MintState[] } }, { state: "minted" as const, linked: false }] };

export function atlasMintStore(): MintStore {
  const col = async () => { const db = await getDb().catch(() => null); return db ? db.collection<MintClaim>("passport_mints") : null; };
  const guard = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch (e) { console.warn(`[passport-mints] ${what} failed:`, (e as Error).message); return null; }
  };
  return {
    admit: (day, cap) => guard("admit", async () => {
      const db = await getDb().catch(() => null);
      if (!db) return null;
      const c = db.collection<{ _id: string; n: number }>("counters"), _id = `passport-mints:${day}`;
      await c.updateOne({ _id }, { $setOnInsert: { n: 0 } }, { upsert: true }).catch((e) => { if ((e as { code?: number }).code !== 11000) throw e; });
      // one atomic step: counts only while n < cap, so concurrent requests can never push it past the cap
      const r = await c.updateOne({ _id, n: { $lt: cap } }, { $inc: { n: 1 } });
      return r.modifiedCount === 1 ? "admitted" as const : "over" as const;
    }),
    claim: (c) => guard("claim", async () => {
      const m = await col();
      if (!m) return null;
      try { await m.insertOne(c); return "won" as const; } catch (e) {
        if ((e as { code?: number }).code === 11000) return "lost" as const;
        throw e;
      }
    }),
    update: (dealId, patch) => guard("update", async () => {
      const m = await col();
      if (!m) return null;
      const r = await m.updateOne({ _id: dealId }, { $set: { ...patch, updatedAt: new Date().toISOString() } });
      return r.matchedCount === 1;
    }),
    get: (dealId) => guard("get", async () => {
      const m = await col();
      if (!m) return null;
      return (await m.findOne({ _id: dealId }, { maxTimeMS: 3_000 })) ?? ("none" as const);
    }),
    open: (limit, nowIso) => guard("open", async () => {
      const m = await col();
      if (!m) return null;
      return m.find({ ...OPEN, nextAttemptAt: { $lte: nowIso } },
        { sort: { nextAttemptAt: 1 }, limit }).toArray();
    }),
    takeDue: (dealId, nowIso, holdUntilIso) => guard("takeDue", async () => {
      const m = await col();
      if (!m) return null;
      return m.findOneAndUpdate({ _id: dealId, ...OPEN, nextAttemptAt: { $lte: nowIso } }, { $set: { nextAttemptAt: holdUntilIso } },
        { returnDocument: "before", maxTimeMS: 3_000 });
    }),
    link: (dealId, address) => recordPassportAsset(dealId, address),
  };
}

export type MintOutcome = { state: MintState | "skipped" | "refused"; address?: string; reason?: string };

/** The whole mint for one captured sale: admit, claim, pre-check, one send, link. Never throws. */
export async function mintPassport(fields: PassportFields, baseUrl: string, store: MintStore = atlasMintStore(), umiIn?: Umi, now = () => Date.now(), cap = dailyCap()): Promise<MintOutcome> {
  if (cap === 0) return { state: "skipped", reason: "passport minting is switched off (PASSPORT_DAILY_CAP=0)" };
  const umi = umiIn ?? umiFromEnv();
  if (!("rpc" in umi)) return { state: "skipped", reason: umi.reason };
  const t = now();
  // a duplicate pickup for a deal that already has a claim uses up one slot; that errs on the side of fewer mints
  const admitted = await store.admit(iso(t).slice(0, 10), cap);
  if (admitted !== "admitted") {
    return { state: "refused", reason: admitted === null ? "could not read today's mint count (fail closed)" : `daily passport cap of ${cap} reached` };
  }
  const signer = newAssetSigner(umi);
  const address = signer.publicKey.toString();
  const won = await store.claim({ _id: fields.dealId, address, state: "pending", admitted: true, attemptAt: iso(t), nextAttemptAt: iso(t + SETTLE_AFTER_MS),
    linked: false, linkAttempts: 0, fields, baseUrl, createdAt: iso(t), updatedAt: iso(t) });
  if (won === null) return { state: "skipped", reason: "mint claims are not reachable in Atlas; nothing was sent" };
  if (won === "lost") return { state: "skipped", reason: "this deal already has a mint claim" };
  // best effort: concurrent mints can each pass this and dip slightly below the floor, which is accepted on devnet
  const low = await balanceRefusal(umi, MINT_COST_LAMPORTS);
  if (low) {
    await store.update(fields.dealId, { state: "not_minted", reason: low });
    return { state: "not_minted", address, reason: low };
  }
  const out = await sendCreate(umi, signer, fields, baseUrl);
  if (out.kind === "failed") {
    await store.update(fields.dealId, { state: "not_minted", reason: out.reason });
    return { state: "not_minted", address, reason: out.reason };
  }
  if (out.kind === "uncertain") {
    await store.update(fields.dealId, { state: "uncertain", reason: out.reason });
    return { state: "uncertain", address, reason: out.reason };
  }
  // if this write is lost the claim stays "pending"; the cron finds the asset at the stored address and fixes it
  await store.update(fields.dealId, { state: "minted", signature: out.signature, reason: null });
  if (await store.link(fields.dealId, address)) await store.update(fields.dealId, { linked: true });
  return { state: "minted", address };
}

export interface ReconcileDeps {
  store?: MintStore;
  read?: (address: string) => Promise<{ address: string } | null>;
  now?: () => number;
  cap?: number;
  /** asked before each claim; false means stop and leave the rest for the next run */
  canStartChainWork?: () => boolean;
  maxPerRun?: number;
}

/** One due claim, never a send: minted but unlinked = retry the deal link (backing off, then link_failed);
 *  pending/uncertain = read the STORED address: found = minted and linked; absent and recent = wait; absent after
 *  SETTLE_AFTER_MS = not_minted for good. The cron and a passport page view both use this. */
async function settleClaim(store: MintStore, read: NonNullable<ReconcileDeps["read"]>, now: () => number, c: MintClaim): Promise<string> {
  const linkOrBackOff = async (prefix: string) => {
    if (await store.link(c._id, c.address)) { await store.update(c._id, { linked: true }); return `${prefix}linked`; }
    const n = (c.linkAttempts ?? 0) + 1;
    if (n >= MAX_LINK_ATTEMPTS) {
      await store.update(c._id, { state: "link_failed", linkAttempts: n, reason: "the deal record never accepted the asset" });
      return `${prefix}link failed for good`;
    }
    await store.update(c._id, { linkAttempts: n, nextAttemptAt: iso(now() + SETTLE_AFTER_MS * 2 ** n) });
    return `${prefix}link retry later`;
  };
  if (c.state === "minted") return linkOrBackOff("");
  let found: { address: string } | null;
  try { found = await read(c.address); } catch {
    await store.update(c._id, { nextAttemptAt: iso(now() + SETTLE_AFTER_MS) });
    return "devnet unreadable; later";
  }
  if (found) {
    await store.update(c._id, { state: "minted", reason: null });
    return linkOrBackOff("found on chain, ");
  }
  const settleAt = Date.parse(c.attemptAt) + SETTLE_AFTER_MS;
  if (now() < settleAt) {
    await store.update(c._id, { nextAttemptAt: iso(settleAt) });
    return "not on chain yet";
  }
  await store.update(c._id, { state: "not_minted", reason: "the asset never landed; this sale keeps its Memo passport" });
  return "not minted";
}

/** Settles due admitted claims, bounded by maxPerRun and the time gate on every branch. */
export async function reconcileMints(d: ReconcileDeps = {}) {
  const results: { dealId: string; result: string }[] = [];
  if ((d.cap ?? dailyCap()) === 0) return { checked: 0, results, unavailable: false, off: true };
  const store = d.store ?? atlasMintStore();
  const read = d.read ?? readPassportAsset;
  const now = d.now ?? (() => Date.now());
  const max = d.maxPerRun ?? RECONCILE_PER_RUN;
  const claims = await store.open(25, iso(now()));
  if (!claims) return { checked: 0, results, unavailable: true };
  let done = 0;
  for (const c of claims) {
    if (!c.admitted) continue; // never act on a claim that did not pass the cap
    if (done >= max || (d.canStartChainWork && !d.canStartChainWork())) { results.push({ dealId: c._id, result: "deferred" }); continue; }
    done++;
    results.push({ dealId: c._id, result: await settleClaim(store, read, now, c) });
  }
  return { checked: claims.length, results, unavailable: false };
}

/** The cron runs daily, so the passport page settles THE ONE claim being viewed once it is due (past its settle window
 *  or link backoff): the same one-address lookup, never a send. Taking it pushes nextAttemptAt VIEW_RECHECK_MS ahead in
 *  one conditional update, so page refreshes and concurrent viewers look at devnet at most once per VIEW_RECHECK_MS. */
export async function settleViewedMint(dealId: string, d: Omit<ReconcileDeps, "canStartChainWork" | "maxPerRun"> = {}): Promise<string | null> {
  if ((d.cap ?? dailyCap()) === 0) return null;
  const store = d.store ?? atlasMintStore();
  const read = d.read ?? ((a: string) => deadline(readPassportAsset(a), 8_000, "asset read"));
  const now = d.now ?? (() => Date.now());
  const c = await store.takeDue(dealId, iso(now()), iso(now() + VIEW_RECHECK_MS));
  if (!c || !c.admitted) return null;
  return settleClaim(store, read, now, c);
}
