import type { Collection } from "mongodb";
import { getDb } from "@/server/db/mongo";
import type { DealStatus } from "./settle";
import { CATALOG } from "@/server/shop/catalog";
import { DEMO_TABLE } from "@/core/demoTable";

const KNOWN_TITLES = new Set<string>([...DEMO_TABLE.map((d) => d.label), ...CATALOG.map((l) => l.title.slice(0, 80))]);

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

/** Runs a store call with a hard deadline; on timeout or error it logs and returns null. The money routes do
 *  not wait for writes at all (they hand them to waitUntil), so the deadline only bounds background work. */
async function safely<T>(what: string, fn: () => Promise<T>, ms = 8000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([fn(), new Promise<never>((_, bad) => { timer = setTimeout(() => bad(new Error(`timed out after ${ms} ms`)), ms); })]);
  } catch (e) {
    console.warn(`[deals] ${what} failed:`, (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
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
    // an already-final deal keeps its final status, reason and passport; a later scan is appended to the timeline only
    const final = { $in: ["$status", ["CAPTURED", "REVERSED"]] };
    const update = () => c.updateOne({ _id: dealId }, [{ $set: {
      status: { $cond: [final, "$status", s.status] },
      verdict: { $cond: [final, "$verdict", { $literal: s.verdict }] },
      passportPath: { $cond: [final, "$passportPath", s.passportPath ?? null] },
      updatedAt: at,
      events: { $concatArrays: ["$events", [{ $literal: { at, status: s.status, note } }]] },
    } }]);
    // the hold's record is written in the background too: if this settlement arrives first, wait for it briefly
    let r = await update();
    for (let i = 0; i < 3 && r.matchedCount === 0; i++) {
      await new Promise((ok) => setTimeout(ok, 1500));
      r = await update();
    }
    if (r.matchedCount === 0) {
      console.warn(`[deals] recordSettlement: no record for ${dealId} (its hold was not recorded)`);
      return false;
    }
    return true;
  });
}

/** Only fields a buyer and seller both see at the curb; no card data, no Visa ids. */
export type PublicDeal = Omit<DealRecord, "_id"> & { dealId: string };
const pub = (d: DealRecord): PublicDeal => { const { _id, ...rest } = d; return { dealId: _id, ...rest }; };

export type DealLookup = { state: "ok"; deal: PublicDeal } | { state: "missing" } | { state: "unavailable" };

export async function getDeal(dealId: string): Promise<DealLookup> {
  const r = await safely<DealLookup>("getDeal", async () => {
    const c = await deals();
    if (!c) return { state: "unavailable" };
    const d = await c.findOne({ _id: dealId });
    return d ? { state: "ok", deal: pub(d) } : { state: "missing" };
  }, 4000);
  return r ?? { state: "unavailable" };
}

export async function board(limit = 20) {
  // reads get a longer deadline than the money-path writes
  return safely("board", async () => {
    const c = await deals();
    if (!c) return null;
    // the board is public: only listing text we wrote (catalog titles, demo-table items) is shown verbatim
    const recent = (await c.find({}, { sort: { updatedAt: -1 }, limit }).toArray()).map(pub)
      .map((d) => ({ ...d, listing: KNOWN_TITLES.has(d.listing) ? d.listing : "A listing" }));
    const byStatus = Object.fromEntries((await c.aggregate<{ _id: string; n: number; usd: number }>([
      { $group: { _id: "$status", n: { $sum: 1 }, usd: { $sum: "$amountUsd" } } }]).toArray()).map((g) => [g._id, { n: g.n, usd: Math.round(g.usd * 100) / 100 }]));
    return { recent, byStatus };
  }, 4000);
}
