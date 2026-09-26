import type { Collection } from "mongodb";
import { getDb } from "@/server/db/mongo";
import type { DealStatus } from "./settle";

/**
 * Deal records in MongoDB Atlas: the hold, the pickup decision and the settlement, as a timeline. It powers the
 * seller's live view (/deal/[id]) and the deal board (/board). Writes are best-effort: a database problem is
 * logged and never changes what happened at Visa, which stays the source of truth for the money.
 */
export interface DealEvent { at: string; status: DealStatus | "HELD"; note: string }
export interface DealRecord {
  _id: string; // dealId
  listing: string; amountUsd: number; status: DealStatus; card: string | null; agent: string | null;
  createdAt: string; updatedAt: string; events: DealEvent[];
  verdict?: { kind: string; reason: string; recall?: string | null };
  passportPath?: string | null;
}

async function deals(): Promise<Collection<DealRecord> | null> {
  const db = await getDb();
  return db ? db.collection<DealRecord>("deals") : null;
}

async function safely<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch (e) { console.warn(`[deals] ${what} failed:`, (e as Error).message); return null; }
}

export function recordHold(d: { dealId: string; listing: string; amountUsd: number; card: string | null; agent: string | null }) {
  return safely("recordHold", async () => {
    const c = await deals();
    if (!c) return false;
    const at = new Date().toISOString();
    await c.insertOne({ _id: d.dealId, listing: d.listing, amountUsd: d.amountUsd, status: "HELD", card: d.card, agent: d.agent,
      createdAt: at, updatedAt: at, events: [{ at, status: "HELD", note: `Visa authorized $${d.amountUsd.toFixed(2)} with capture off` }] });
    return true;
  });
}

export function recordSettlement(dealId: string, s: { status: DealStatus; verdict: { kind: string; reason: string; recall?: string | null }; passportPath?: string | null }) {
  return safely("recordSettlement", async () => {
    const c = await deals();
    if (!c) return false;
    const at = new Date().toISOString();
    const note = s.status === "CAPTURED" ? "Label passed: Visa captured the payment to the seller"
      : s.status === "REVERSED" ? "Recalled or banned: Visa reversed the hold, the buyer keeps the money"
      : s.status === "HELD" ? "Needs a check: the hold stays, no money moved"
      : s.status === "REFUSED" ? "Visa refused the settlement (already settled or not open)" : "Visa did not confirm";
    // an already-final deal keeps its final status; a later scan is appended to the timeline only
    await c.updateOne({ _id: dealId }, [{ $set: {
      status: { $cond: [{ $in: ["$status", ["CAPTURED", "REVERSED"]] }, "$status", s.status] },
      updatedAt: at, verdict: s.verdict, passportPath: s.passportPath ?? null,
      events: { $concatArrays: ["$events", [{ at, status: s.status, note }]] },
    } }]);
    return true;
  });
}

/** Only fields a buyer and seller both see at the curb; no card data, no Visa ids. */
export type PublicDeal = Omit<DealRecord, "_id"> & { dealId: string };
const pub = (d: DealRecord): PublicDeal => { const { _id, ...rest } = d; return { dealId: _id, ...rest }; };

export async function getDeal(dealId: string): Promise<PublicDeal | null | undefined> {
  const r = await safely("getDeal", async () => {
    const c = await deals();
    if (!c) return undefined;
    const d = await c.findOne({ _id: dealId });
    return d ? pub(d) : null;
  });
  return r === null ? undefined : r; // undefined = store unavailable, null = no such deal
}

export async function board(limit = 20) {
  return safely("board", async () => {
    const c = await deals();
    if (!c) return null;
    const recent = (await c.find({}, { sort: { updatedAt: -1 }, limit }).toArray()).map(pub);
    const byStatus = Object.fromEntries((await c.aggregate<{ _id: string; n: number; usd: number }>([
      { $group: { _id: "$status", n: { $sum: 1 }, usd: { $sum: "$amountUsd" } } }]).toArray()).map((g) => [g._id, { n: g.n, usd: Math.round(g.usd * 100) / 100 }]));
    return { recent, byStatus };
  });
}
