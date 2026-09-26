import type { Collection } from "mongodb";
import { getDb } from "@/server/db/mongo";
import type { DealStatus } from "./settle";
import { CATALOG } from "@/server/shop/catalog";
import { DEMO_TABLE } from "@/core/demoTable";

const KNOWN_TITLES = new Set<string>([...DEMO_TABLE.map((d) => d.label), ...CATALOG.map((l) => l.title.slice(0, 80))]);
/** Listing text safe to show publicly: only text we wrote (catalog titles, demo-table items), else a placeholder. */
export const publicListing = (t: string) => (KNOWN_TITLES.has(t) ? t : "A listing");

/**
 * Deal records in MongoDB Atlas: the hold, the pickup decision and the settlement, as a timeline. It powers the
 * seller's live view (/deal/[id]) and the deal board (/board). Writes are best-effort: a database problem is
 * logged and never changes what happened at Visa, which stays the source of truth for the money.
 */
/** RELEASED and LAPSED come only from the hold sweeper (src/server/deals/sweep.ts). */
export type RecordStatus = DealStatus | "RELEASED" | "LAPSED";
export interface DealEvent { at: string; status: RecordStatus; note: string }
export interface DealRecord {
  _id: string; // dealId
  listing: string; amountUsd: number; status: RecordStatus; card: string | null; agent: string | null;
  /** Visa authorization id, kept server-side so the sweeper can release an abandoned hold; never public. */
  authId?: string | null;
  /** when the sweeper last tried and Visa did not confirm (the deal stays HELD) */
  sweepAttemptAt?: string;
  createdAt: string; updatedAt: string; events: DealEvent[];
  verdict?: { kind: string; reason: string; recall?: string | null };
  passportPath?: string | null;
  /** what the pickup scan read off the label (model numbers, not personal data); kept for the recall watch */
  label?: SaleLabel | null;
  /** a recall that matched this sale AFTER it was captured (recall watch, src/server/watch/) */
  postSaleRecall?: { recallNumber: string; title: string; url: string; at: string } | null;
}
export interface SaleLabel { model: string | null; batch: string | null; date: string | null; upc: string | null }

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

export function recordHold(d: { dealId: string; listing: string; amountUsd: number; card: string | null; agent: string | null; authId?: string | null }) {
  return safely("recordHold", async () => {
    const c = await deals();
    if (!c) return false;
    const at = new Date().toISOString();
    await c.insertOne({ _id: d.dealId, listing: d.listing, amountUsd: d.amountUsd, status: "HELD", card: d.card, agent: d.agent, authId: d.authId ?? null,
      createdAt: at, updatedAt: at, events: [{ at, status: "HELD", note: `Visa authorized $${d.amountUsd.toFixed(2)} with capture off` }] });
    return true;
  });
}

export function recordSettlement(dealId: string, s: { status: DealStatus; verdict: { kind: string; reason: string; recall?: string | null }; passportPath?: string | null; label?: SaleLabel | null }) {
  return safely("recordSettlement", async () => {
    const c = await deals();
    if (!c) return false;
    const at = new Date().toISOString();
    const note = s.status === "CAPTURED" ? "Label passed: Visa captured the payment to the seller"
      : s.status === "REVERSED" ? "Recalled or banned: Visa reversed the hold, the buyer keeps the money"
      : s.status === "HELD" ? "Needs a check: the hold stays, no money moved"
      : s.status === "REFUSED" ? "Visa refused the settlement (already settled or not open)" : "Visa did not confirm";
    // an already-final deal keeps its final status, reason and passport; a later scan is appended to the timeline only
    // RELEASED and LAPSED (hold sweeper) are final too: a late scan can never re-open a released hold
    const final = { $in: ["$status", ["CAPTURED", "REVERSED", "RELEASED", "LAPSED"]] };
    const update = () => c.updateOne({ _id: dealId }, [{ $set: {
      status: { $cond: [final, "$status", s.status] },
      verdict: { $cond: [final, "$verdict", { $literal: s.verdict }] },
      passportPath: { $cond: [final, "$passportPath", s.passportPath ?? null] },
      // the label is kept only for a sale (the recall watch re-checks it later)
      label: { $cond: [final, "$label", { $literal: s.status === "CAPTURED" ? (s.label ?? null) : null }] },
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
export type PublicDeal = Omit<DealRecord, "_id" | "authId"> & { dealId: string };
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const pub = (d: DealRecord): PublicDeal => { const { _id, authId, ...rest } = d; return { dealId: _id, ...rest }; };

/** What the PUBLIC board and its change stream show for one deal: an explicit allowlist (never authId, never
 *  sweepAttemptAt, never a field added later by accident), and only listing text we wrote (catalog titles,
 *  demo-table items) verbatim; anything else a buyer typed becomes "A listing". */
export type BoardDeal = Pick<PublicDeal, "dealId" | "listing" | "amountUsd" | "status" | "card" | "agent" | "createdAt" | "updatedAt" | "events" | "verdict" | "passportPath">;
export function boardDeal(d: DealRecord): BoardDeal {
  const out: BoardDeal = {
    dealId: d._id, listing: KNOWN_TITLES.has(d.listing) ? d.listing : "A listing", amountUsd: d.amountUsd, status: d.status,
    card: d.card, agent: d.agent, createdAt: d.createdAt, updatedAt: d.updatedAt, events: d.events,
  };
  if (d.verdict !== undefined) out.verdict = d.verdict;
  if (d.passportPath !== undefined) out.passportPath = d.passportPath;
  return out;
}

export type DealLookup ={ state: "ok"; deal: PublicDeal } | { state: "missing" } | { state: "unavailable" };

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
    // the board is public: boardDeal allowlists fields and sanitizes listing text (the change stream uses it too)
    const recent = (await c.find({}, { sort: { updatedAt: -1 }, limit }).toArray()).map(boardDeal);
    const byStatus = Object.fromEntries((await c.aggregate<{ _id: string; n: number; usd: number }>([
      { $group: { _id: "$status", n: { $sum: 1 }, usd: { $sum: "$amountUsd" } } }]).toArray()).map((g) => [g._id, { n: g.n, usd: Math.round(g.usd * 100) / 100 }]));
    return { recent, byStatus };
  }, 4000);
}

/** Held deals older than the cutoff, oldest first, for the sweeper. */
export function heldBefore(cutoffIso: string, limit = 25) {
  return safely("heldBefore", async () => {
    const c = await deals();
    if (!c) return null;
    // never-attempted deals first, so holds Visa keeps not answering for can never block newer ones
    return c.find({ status: "HELD", createdAt: { $lt: cutoffIso } }, { projection: { _id: 1, amountUsd: 1, createdAt: 1, authId: 1, sweepAttemptAt: 1 }, sort: { sweepAttemptAt: 1, createdAt: 1 }, limit }).toArray();
  }, 6000);
}

/** Marks a deal as attempted (before its Visa call, and when Visa did not confirm): it stays HELD and later runs try
 *  other deals first. */
export function recordSweepAttempt(dealId: string) {
  return safely("recordSweepAttempt", async () => {
    const c = await deals();
    if (!c) return false;
    const r = await c.updateOne({ _id: dealId, status: "HELD" }, { $set: { sweepAttemptAt: new Date().toISOString() } });
    return r.modifiedCount === 1;
  });
}

/** Records a sweep result, only if the deal is STILL held (a pickup that settled meanwhile always wins). */
export function recordSweep(dealId: string, status: "RELEASED" | "LAPSED" | "REFUSED", note: string) {
  return safely("recordSweep", async () => {
    const c = await deals();
    if (!c) return false;
    const at = new Date().toISOString();
    const r = await c.updateOne({ _id: dealId, status: "HELD" }, { $set: { status, updatedAt: at }, $push: { events: { at, status, note } } });
    return r.modifiedCount === 1;
  });
}

/** Captured sales with a label to re-check (recall watch). */
export function watchedSales(limit = 1000) {
  return safely("watchedSales", async () => {
    const c = await deals();
    if (!c) return null;
    return c.find({ status: "CAPTURED", $or: [{ "label.model": { $type: "string" } }, { "label.upc": { $type: "string" } }] },
      { projection: { _id: 1, listing: 1, label: 1, postSaleRecall: 1, updatedAt: 1 }, sort: { updatedAt: -1 }, limit }).toArray();
  }, 6000);
}

/** Flags a captured sale with a recall announced after it (once per recall); true when newly flagged. */
export function flagPostSaleRecall(dealId: string, r: { recallNumber: string; title: string; url: string }) {
  return safely("flagPostSaleRecall", async () => {
    const c = await deals();
    if (!c) return false;
    const at = new Date().toISOString();
    const res = await c.updateOne({ _id: dealId, status: "CAPTURED", "postSaleRecall.recallNumber": { $ne: r.recallNumber } },
      { $set: { postSaleRecall: { ...r, at }, updatedAt: at },
        $push: { events: { at, status: "CAPTURED", note: `Recall announced after the sale: CPSC ${r.recallNumber}. The buyer was notified.` } } });
    return res.modifiedCount === 1;
  });
}
