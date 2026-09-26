import { randomUUID } from "node:crypto";
import type { Umi } from "@metaplex-foundation/umi";
import { getDb } from "@/server/db/mongo";
import { recordPassportAsset } from "@/server/deals/store";
import { balanceRefusal, newAssetSigner, readPassportAsset, sendCreate, umiFromEnv, type PassportFields } from "./core";

/**
 * Durable, spend-limited minting of the Core passport (PLAN 6.4).
 *
 * - One claim per deal: an insert into `passport_mints` with _id = dealId, so concurrent pickups race on Atlas's unique
 *   _id and exactly one wins.
 * - Every attempt's asset address is stored in the claim BEFORE its transaction is sent. An ambiguous send is settled by
 *   reading that stored address. Only when the stored address is confirmed absent AND its attempt is older than
 *   RETRY_AFTER_MS (so its blockhash has long expired and it can no longer land) may the cron start a new attempt with a
 *   new address, taken with one conditional update so exactly one worker wins; MAX_ATTEMPTS, then the claim fails.
 *   The asset signer's secret key is never stored anywhere.
 * - A global daily cap counted atomically in Atlas that fails closed. Checkout is public by design (judges use it) and
 *   devnet SOL has no monetary value, but the cap keeps the demo wallet from running dry.
 * - The balance check and the send run under one global Atlas lease, so concurrent mints for different deals cannot all
 *   pass the check before any of them spends. The check reserves one mint's cost, so the wallet stays at or above the
 *   0.02 SOL floor after the send. A busy lease is not waited on: the claim stays pending and the cron retries it.
 * - The cron's reconcile is bounded: a per-run item cap and a remaining-time gate on every branch, claims picked by
 *   nextAttemptAt (so an old failure cannot block newer ones), and deal-link retries back off and end as link_failed.
 */
export type MintState = "pending" | "minted" | "uncertain" | "failed" | "refused" | "link_failed";
export interface MintClaim {
  _id: string; // dealId
  address: string; state: MintState; linked: boolean; fields: PassportFields; baseUrl: string;
  /** attempts started for this deal, each with its own address (at most MAX_ATTEMPTS) */
  attempts: number;
  /** when the current attempt started; a new attempt is allowed only RETRY_AFTER_MS after it */
  attemptAt: string;
  /** the cron looks at this claim no earlier than this */
  nextAttemptAt: string;
  linkAttempts: number;
  signature?: string | null; reason?: string | null; createdAt: string; updatedAt: string;
}
type Patch = Partial<Omit<MintClaim, "_id">>;

/** Everything the mint flow needs from storage; atlasMintStore() is the real one, tests pass a fake. */
export interface MintStore {
  /** "won" = this caller holds the deal's only claim; "lost" = someone already claimed it; null = store unavailable */
  claim(c: MintClaim): Promise<"won" | "lost" | null>;
  update(dealId: string, patch: Patch): Promise<boolean | null>;
  /** conditional update: applies only if the claim still has exactly this state, attempt count and address */
  retake(dealId: string, expect: Pick<MintClaim, "state" | "attempts" | "address">, patch: Patch): Promise<boolean | null>;
  /** atomically counts one more mint for today (UTC) and returns the new count; null = count unreadable */
  countMint(day: string): Promise<number | null>;
  /** claims due for work (nextAttemptAt <= now), soonest first: pending, uncertain, or minted but not linked */
  open(limit: number, nowIso: string): Promise<MintClaim[] | null>;
  /** links the asset address to the deal record; true when the deal now points at it */
  link(dealId: string, address: string): Promise<boolean | null>;
  /** the global send lease: true = held by `holder` until `now + ttlMs`; false = someone else holds it; null = unreadable */
  acquireLease(holder: string, now: number, ttlMs: number): Promise<boolean | null>;
  releaseLease(holder: string): Promise<void>;
}

const capRaw = process.env.PASSPORT_DAILY_CAP?.trim();
const capNum = Number(capRaw);
/** "0" turns minting off; an empty or mistyped setting falls back to 50. */
export const PASSPORT_DAILY_CAP = capRaw === "0" ? 0 : Number.isFinite(capNum) && capNum > 0 ? Math.floor(capNum) : 50;
/** A Solana blockhash is valid for about 150 slots (60 to 90 s) and a pickup function runs at most 120 s, so an attempt
 *  whose address is still absent this long after it started can no longer land. */
export const RETRY_AFTER_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 3;
export const MAX_LINK_ATTEMPTS = 5;
/** balance 8 s + a 40 s send, with room: the lease can never expire while its holder is still sending */
export const LEASE_TTL_MS = 60_000;
/** what one create may spend: measured about 0.0043 SOL on devnet (fee + rent), reserved with margin */
export const MINT_COST_LAMPORTS = 6_000_000n;
/** at most this many claims handled per reconcile run, whatever their branch */
export const RECONCILE_PER_RUN = 5;

const iso = (ms: number) => new Date(ms).toISOString();

export function atlasMintStore(): MintStore {
  const col = async () => { const db = await getDb().catch(() => null); return db ? db.collection<MintClaim>("passport_mints") : null; };
  const guard = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch (e) { console.warn(`[passport-mints] ${what} failed:`, (e as Error).message); return null; }
  };
  const locks = async () => { const db = await getDb().catch(() => null); return db ? db.collection<{ _id: string; holder: string; expiresAt: number }>("locks") : null; };
  return {
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
    retake: (dealId, e, patch) => guard("retake", async () => {
      const m = await col();
      if (!m) return null;
      const r = await m.updateOne({ _id: dealId, state: e.state, attempts: e.attempts, address: e.address },
        { $set: { ...patch, updatedAt: new Date().toISOString() } });
      return r.modifiedCount === 1;
    }),
    countMint: (day) => guard("countMint", async () => {
      const db = await getDb().catch(() => null);
      if (!db) return null;
      const doc = await db.collection<{ _id: string; n: number }>("counters").findOneAndUpdate(
        { _id: `passport-mints:${day}` }, { $inc: { n: 1 } }, { upsert: true, returnDocument: "after", maxTimeMS: 3_000 });
      return typeof doc?.n === "number" ? doc.n : null;
    }),
    open: (limit, nowIso) => guard("open", async () => {
      const m = await col();
      if (!m) return null;
      return m.find({ nextAttemptAt: { $lte: nowIso }, $or: [{ state: { $in: ["pending", "uncertain"] } }, { state: "minted", linked: false }] },
        { sort: { nextAttemptAt: 1 }, limit }).toArray();
    }),
    link: (dealId, address) => recordPassportAsset(dealId, address),
    acquireLease: (holder, now, ttlMs) => guard("acquireLease", async () => {
      const l = await locks();
      if (!l) return null;
      try {
        // matches only a free (expired) lease or our own; otherwise the upsert collides on _id and we do not hold it
        await l.findOneAndUpdate({ _id: "mint-lease", $or: [{ expiresAt: { $lt: now } }, { holder }] },
          { $set: { holder, expiresAt: now + ttlMs } }, { upsert: true, maxTimeMS: 3_000 });
        return true;
      } catch (e) {
        if ((e as { code?: number }).code === 11000) return false;
        throw e;
      }
    }),
    releaseLease: async (holder) => {
      await guard("releaseLease", async () => { const l = await locks(); await l?.deleteOne({ _id: "mint-lease", holder }); });
    },
  };
}

export type MintOutcome = { state: MintState | "skipped"; address?: string; reason?: string };

/** The whole mint for one captured sale. Never throws; every step that can fail leaves the claim in a state the cron
 *  reconciles. */
export async function mintPassport(fields: PassportFields, baseUrl: string, store: MintStore = atlasMintStore(), umiIn?: Umi, now = () => Date.now()): Promise<MintOutcome> {
  if (PASSPORT_DAILY_CAP === 0) return { state: "skipped", reason: "passport minting is switched off (PASSPORT_DAILY_CAP=0)" };
  const umi = umiIn ?? umiFromEnv();
  if (!("rpc" in umi)) return { state: "skipped", reason: umi.reason };
  const signer = newAssetSigner(umi);
  const address = signer.publicKey.toString();
  const t = now();
  const won = await store.claim({ _id: fields.dealId, address, state: "pending", attempts: 1, attemptAt: iso(t), nextAttemptAt: iso(t + RETRY_AFTER_MS),
    linked: false, linkAttempts: 0, fields, baseUrl, createdAt: iso(t), updatedAt: iso(t) });
  if (won === null) return { state: "skipped", reason: "mint claims are not reachable in Atlas; nothing was sent" };
  if (won === "lost") return { state: "skipped", reason: "this deal already has a mint claim" };
  // the claim is ours: count it against today's cap, failing closed
  const n = await store.countMint(iso(t).slice(0, 10));
  if (n === null || n > PASSPORT_DAILY_CAP) {
    const reason = n === null ? "could not read today's mint count (fail closed)" : `daily passport cap of ${PASSPORT_DAILY_CAP} reached`;
    await store.update(fields.dealId, { state: "refused", reason });
    return { state: "refused", address, reason };
  }
  return attemptSend(store, umi, signer, fields, baseUrl, now);
}

/** One attempt, for a claim that already stores this signer's address as pending: lease, balance, send, record, link. */
async function attemptSend(store: MintStore, umi: Umi, signer: ReturnType<typeof newAssetSigner>, fields: PassportFields, baseUrl: string, now: () => number): Promise<MintOutcome> {
  const dealId = fields.dealId, address = signer.publicKey.toString();
  const holder = randomUUID();
  const lease = await store.acquireLease(holder, now(), LEASE_TTL_MS);
  if (!lease) {
    // nothing is sent, so this address can never land; the cron starts a fresh attempt after RETRY_AFTER_MS
    const reason = lease === null ? "the send lease is unreadable (fail closed); the cron retries" : "another mint was sending; the cron retries";
    await store.update(dealId, { reason });
    return { state: "pending", address, reason };
  }
  let out: Awaited<ReturnType<typeof sendCreate>>;
  try {
    const low = await balanceRefusal(umi, MINT_COST_LAMPORTS);
    if (low) {
      console.warn(`[passport-mints] ${dealId} not sent: ${low}`);
      await store.update(dealId, { reason: `${low}; the cron retries` });
      return { state: "pending", address, reason: low };
    }
    await store.update(dealId, { attemptAt: iso(now()), nextAttemptAt: iso(now() + RETRY_AFTER_MS) });
    out = await sendCreate(umi, signer, fields, baseUrl);
    if (out.kind === "failed") await store.update(dealId, { state: "failed", reason: out.reason });
    else if (out.kind === "uncertain") await store.update(dealId, { state: "uncertain", reason: out.reason });
    // if this write is lost the claim stays "pending"; the cron finds the asset at the stored address and fixes it
    else await store.update(dealId, { state: "minted", signature: out.signature, reason: null });
  } finally {
    await store.releaseLease(holder);
  }
  if (out.kind !== "ok") return { state: out.kind, address, reason: out.reason };
  const linked = await store.link(dealId, address);
  if (linked) await store.update(dealId, { linked: true });
  return { state: "minted", address };
}

export interface ReconcileDeps {
  store?: MintStore;
  read?: (address: string) => Promise<{ address: string } | null>;
  umi?: Umi;
  now?: () => number;
  /** asked before each claim; false means stop and leave the rest for the next run */
  canStartChainWork?: () => boolean;
  maxPerRun?: number;
}

/** Settles due claims, bounded by maxPerRun and the time gate on every branch:
 *  - minted but unlinked: retry the deal link with exponential backoff, then link_failed;
 *  - pending/uncertain: read the STORED address; found = minted; absent and recent = wait; absent and older than
 *    RETRY_AFTER_MS = a new attempt with a new address (conditional, one winner), or failed after MAX_ATTEMPTS. */
export async function reconcileMints(d: ReconcileDeps = {}) {
  const store = d.store ?? atlasMintStore();
  const read = d.read ?? readPassportAsset;
  const now = d.now ?? (() => Date.now());
  const max = d.maxPerRun ?? RECONCILE_PER_RUN;
  const results: { dealId: string; result: string }[] = [];
  const claims = await store.open(25, iso(now()));
  if (!claims) return { checked: 0, results, unavailable: true };
  let umi: Umi | { reason: string } | undefined = d.umi;
  let done = 0;
  const linkOrBackOff = async (c: MintClaim, prefix: string) => {
    const ok = await store.link(c._id, c.address);
    if (ok) { await store.update(c._id, { linked: true }); return `${prefix}linked`; }
    const n = (c.linkAttempts ?? 0) + 1;
    if (n >= MAX_LINK_ATTEMPTS) {
      await store.update(c._id, { state: "link_failed", linkAttempts: n, reason: "the deal record never accepted the asset" });
      return `${prefix}link failed for good`;
    }
    await store.update(c._id, { linkAttempts: n, nextAttemptAt: iso(now() + RETRY_AFTER_MS * 2 ** n) });
    return `${prefix}link retry later`;
  };
  for (const c of claims) {
    if (done >= max || (d.canStartChainWork && !d.canStartChainWork())) { results.push({ dealId: c._id, result: "deferred" }); continue; }
    done++;
    if (c.state === "minted") { results.push({ dealId: c._id, result: await linkOrBackOff(c, "") }); continue; }
    let found: { address: string } | null;
    try { found = await read(c.address); } catch {
      await store.update(c._id, { nextAttemptAt: iso(now() + RETRY_AFTER_MS) });
      results.push({ dealId: c._id, result: "devnet unreadable; later" });
      continue;
    }
    if (found) {
      await store.update(c._id, { state: "minted", reason: null });
      results.push({ dealId: c._id, result: await linkOrBackOff({ ...c, state: "minted" }, "found on chain, ") });
      continue;
    }
    const since = now() - Date.parse(c.attemptAt);
    if (since < RETRY_AFTER_MS) {
      await store.update(c._id, { nextAttemptAt: iso(Date.parse(c.attemptAt) + RETRY_AFTER_MS) });
      results.push({ dealId: c._id, result: "not on chain yet" });
      continue;
    }
    if (c.attempts >= MAX_ATTEMPTS) {
      await store.update(c._id, { state: "failed", reason: `no asset after ${c.attempts} attempts` });
      results.push({ dealId: c._id, result: "failed after max attempts" });
      continue;
    }
    // the stored address is confirmed absent long after its blockhash expired: a new attempt, one winner
    umi ??= umiFromEnv();
    if (!("rpc" in umi)) { results.push({ dealId: c._id, result: `cannot retry: ${umi.reason}` }); continue; }
    const signer = newAssetSigner(umi);
    const t = now();
    const took = await store.retake(c._id, { state: c.state, attempts: c.attempts, address: c.address },
      { state: "pending", attempts: c.attempts + 1, address: signer.publicKey.toString(), attemptAt: iso(t), nextAttemptAt: iso(t + RETRY_AFTER_MS), reason: null });
    if (!took) { results.push({ dealId: c._id, result: "another worker took this attempt" }); continue; }
    const out = await attemptSend(store, umi, signer, c.fields, c.baseUrl, now);
    results.push({ dealId: c._id, result: `attempt ${c.attempts + 1}: ${out.state}` });
  }
  return { checked: claims.length, results, unavailable: false };
}
