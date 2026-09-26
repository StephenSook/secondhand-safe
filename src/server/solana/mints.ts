import type { Umi } from "@metaplex-foundation/umi";
import { getDb } from "@/server/db/mongo";
import { recordPassportAsset } from "@/server/deals/store";
import { balanceRefusal, newAssetSigner, readPassportAsset, sendCreate, umiFromEnv, type PassportFields } from "./core";

/**
 * Durable, spend-limited minting of the Core passport (PLAN 6.4).
 *
 * - One mint per deal, ever: the claim is an insert into `passport_mints` with _id = dealId, so concurrent pickups (or
 *   retries) race on Atlas's unique _id and exactly one wins. The asset address is generated and stored in the claim
 *   BEFORE the transaction is sent, so an ambiguous send is reconciled by reading that same address later; a second
 *   address for the same deal is never generated.
 * - A global daily cap counted atomically in Atlas that fails closed (no readable count, no mint). Checkout is public by
 *   design (judges use it), and devnet SOL has no monetary value, but the cap keeps the demo wallet from running dry.
 * - The 0.02 SOL balance floor in core.ts still applies before every mint.
 */
export type MintState = "pending" | "minted" | "uncertain" | "failed" | "refused";
export interface MintClaim {
  _id: string; // dealId
  address: string; state: MintState; linked: boolean; fields: PassportFields; baseUrl: string;
  signature?: string | null; reason?: string | null; createdAt: string; updatedAt: string;
}

/** Everything the mint flow needs from storage; atlasMintStore() is the real one, tests pass a fake. */
export interface MintStore {
  /** "won" = this caller holds the deal's only claim; "lost" = someone already claimed it; null = store unavailable */
  claim(c: MintClaim): Promise<"won" | "lost" | null>;
  update(dealId: string, patch: Partial<Omit<MintClaim, "_id" | "address">>): Promise<boolean | null>;
  /** atomically counts one more mint for today (UTC) and returns the new count; null = count unreadable */
  countMint(day: string): Promise<number | null>;
  /** claims that still need work: pending or uncertain, or minted but not yet linked to the deal */
  open(limit: number): Promise<MintClaim[] | null>;
  /** links the asset address to the deal record; true when the deal now points at it */
  link(dealId: string, address: string): Promise<boolean | null>;
}

const capRaw = process.env.PASSPORT_DAILY_CAP?.trim();
const capNum = Number(capRaw);
/** "0" turns minting off; an empty or mistyped setting falls back to 50. */
export const PASSPORT_DAILY_CAP = capRaw === "0" ? 0 : Number.isFinite(capNum) && capNum > 0 ? Math.floor(capNum) : 50;
/** a pending or uncertain claim whose asset is still absent after this long can no longer land (its blockhash expired) */
export const MINT_EXPIRY_MS = 10 * 60_000;

export function atlasMintStore(): MintStore {
  const col = async () => { const db = await getDb().catch(() => null); return db ? db.collection<MintClaim>("passport_mints") : null; };
  const guard = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch (e) { console.warn(`[passport-mints] ${what} failed:`, (e as Error).message); return null; }
  };
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
    countMint: (day) => guard("countMint", async () => {
      const db = await getDb().catch(() => null);
      if (!db) return null;
      const doc = await db.collection<{ _id: string; n: number }>("counters").findOneAndUpdate(
        { _id: `passport-mints:${day}` }, { $inc: { n: 1 } }, { upsert: true, returnDocument: "after", maxTimeMS: 3_000 });
      return typeof doc?.n === "number" ? doc.n : null;
    }),
    open: (limit) => guard("open", async () => {
      const m = await col();
      if (!m) return null;
      return m.find({ $or: [{ state: { $in: ["pending", "uncertain"] } }, { state: "minted", linked: false }] }, { sort: { createdAt: 1 }, limit }).toArray();
    }),
    link: (dealId, address) => recordPassportAsset(dealId, address),
  };
}

export type MintOutcome = { state: MintState | "skipped"; address?: string; reason?: string };

/** The whole mint for one captured sale. Never throws; every step that can fail leaves the claim in a state the cron
 *  reconciles. */
export async function mintPassport(fields: PassportFields, baseUrl: string, store: MintStore = atlasMintStore(), umiIn?: Umi, now = () => Date.now()): Promise<MintOutcome> {
  if (PASSPORT_DAILY_CAP === 0) return { state: "skipped", reason: "passport minting is switched off (PASSPORT_DAILY_CAP=0)" };
  const umi = umiIn ?? umiFromEnv();
  if (!("rpc" in umi)) return { state: "skipped", reason: umi.reason };
  const low = await balanceRefusal(umi);
  if (low) { console.warn(`[passport-mints] refused: ${low}`); return { state: "skipped", reason: low }; }
  const signer = newAssetSigner(umi);
  const address = signer.publicKey.toString();
  const at = new Date(now()).toISOString();
  const won = await store.claim({ _id: fields.dealId, address, state: "pending", linked: false, fields, baseUrl, createdAt: at, updatedAt: at });
  if (won === null) return { state: "skipped", reason: "mint claims are not reachable in Atlas; nothing was sent" };
  if (won === "lost") return { state: "skipped", reason: "this deal already has a mint claim" };
  // the claim is ours: count it against today's cap, failing closed
  const n = await store.countMint(at.slice(0, 10));
  if (n === null || n > PASSPORT_DAILY_CAP) {
    const reason = n === null ? "could not read today's mint count (fail closed)" : `daily passport cap of ${PASSPORT_DAILY_CAP} reached`;
    await store.update(fields.dealId, { state: "refused", reason });
    return { state: "refused", address, reason };
  }
  const out = await sendCreate(umi, signer, fields, baseUrl);
  if (out.kind === "failed") {
    await store.update(fields.dealId, { state: "failed", reason: out.reason });
    return { state: "failed", address, reason: out.reason };
  }
  if (out.kind === "uncertain") {
    await store.update(fields.dealId, { state: "uncertain", reason: out.reason });
    return { state: "uncertain", address, reason: out.reason };
  }
  // if this write is lost the claim stays "pending"; the cron finds the asset at the stored address and fixes it
  await store.update(fields.dealId, { state: "minted", signature: out.signature, reason: null });
  const linked = await store.link(fields.dealId, address);
  if (linked) await store.update(fields.dealId, { linked: true });
  return { state: "minted", address };
}

export interface ReconcileDeps {
  store?: MintStore;
  read?: (address: string) => Promise<{ address: string } | null>;
  now?: () => number;
  /** asked before each devnet read; false means stop and leave the rest for the next run */
  canStartChainWork?: () => boolean;
  maxChainReads?: number;
}

/** Settles open claims: finds pending/uncertain assets at their STORED address, retries a failed deal link, and marks a
 *  claim failed only once its transaction can no longer land. Never sends a transaction. */
export async function reconcileMints(d: ReconcileDeps = {}) {
  const store = d.store ?? atlasMintStore();
  const read = d.read ?? readPassportAsset;
  const now = d.now ?? (() => Date.now());
  const maxReads = d.maxChainReads ?? 5;
  const claims = await store.open(25);
  if (!claims) return { checked: 0, results: [] as { dealId: string; result: string }[], unavailable: true };
  const results: { dealId: string; result: string }[] = [];
  let reads = 0;
  for (const c of claims) {
    if (c.state === "minted") {
      const ok = await store.link(c._id, c.address);
      if (ok) await store.update(c._id, { linked: true });
      results.push({ dealId: c._id, result: ok ? "linked" : "link retry next run" });
      continue;
    }
    if (reads >= maxReads || (d.canStartChainWork && !d.canStartChainWork())) { results.push({ dealId: c._id, result: "deferred" }); continue; }
    reads++;
    let found: { address: string } | null;
    try { found = await read(c.address); } catch { results.push({ dealId: c._id, result: "devnet unreadable; next run" }); continue; }
    if (found) {
      await store.update(c._id, { state: "minted", reason: null });
      const ok = await store.link(c._id, c.address);
      if (ok) await store.update(c._id, { linked: true });
      results.push({ dealId: c._id, result: ok ? "found on chain, linked" : "found on chain, link retry next run" });
    } else if (now() - Date.parse(c.createdAt) > MINT_EXPIRY_MS) {
      await store.update(c._id, { state: "failed", reason: "never landed; its blockhash has expired" });
      results.push({ dealId: c._id, result: "never landed" });
    } else {
      results.push({ dealId: c._id, result: "not on chain yet" });
    }
  }
  return { checked: claims.length, results, unavailable: false };
}
