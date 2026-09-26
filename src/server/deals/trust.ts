import { getDb } from "@/server/db/mongo";

/**
 * Trust and Safety console data (PLAN 5.8): the view a marketplace's trust and safety and payments teams would
 * watch. Every number is computed from the deal records in MongoDB Atlas at request time; none is typed in.
 * No Visa ids, card data or listing text leave this function.
 */
export interface TrustStats {
  asOf: string;
  deals: number;
  byStatus: Record<string, { n: number; usd: number }>;
  /** why holds were reversed: recall number or banned type */
  reversalReasons: { reason: string; recall: string | null; n: number; usd: number }[];
  /** money that never reached a seller of a recalled or banned item */
  keptFromBadItemsUsd: number;
  /** seconds from the hold to the pickup decision, over settled deals */
  decisionSeconds: { median: number | null; p90: number | null; n: number };
  bySource: { agent: number; person: number };
  byCard: Record<string, number>;
  /** deals created per hour, last 24 hours, oldest first */
  hourly: { hour: string; n: number }[];
  /** Visa Direct seller payouts by outcome (empty until Visa Direct is live on this deployment) */
  payouts: Record<string, { n: number; usd: number }>;
}

type Doc = {
  status: string; amountUsd: number; card: string | null; agent: string | null; createdAt: string;
  events?: { at: string; status: string }[]; verdict?: { kind?: string; recall?: string | null };
  payout?: { status?: string; amountUsd?: number } | null;
};

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Pure: builds the console from deal records, so it is tested without a database. */
export function summarize(docs: Doc[], now = new Date()): TrustStats {
  const byStatus: TrustStats["byStatus"] = {};
  const reasons = new Map<string, { reason: string; recall: string | null; n: number; usd: number }>();
  const seconds: number[] = [];
  const byCard: Record<string, number> = {};
  let agent = 0;
  const hours = new Map<string, number>();
  const payouts: TrustStats["payouts"] = {};
  const start = new Date(now.getTime() - 23 * 3_600_000);
  start.setUTCMinutes(0, 0, 0);
  for (let h = 0; h < 24; h++) hours.set(new Date(start.getTime() + h * 3_600_000).toISOString().slice(0, 13), 0);

  for (const d of docs) {
    const s = (byStatus[d.status] ??= { n: 0, usd: 0 });
    s.n++; s.usd = round2(s.usd + (d.amountUsd || 0));
    if (d.agent) agent++;
    if (d.payout?.status) {
      const p = (payouts[d.payout.status] ??= { n: 0, usd: 0 });
      p.n++; p.usd = round2(p.usd + (d.payout.amountUsd || 0));
    }
    byCard[d.card ?? "unknown"] = (byCard[d.card ?? "unknown"] ?? 0) + 1;
    const hk = (d.createdAt ?? "").slice(0, 13);
    if (hours.has(hk)) hours.set(hk, (hours.get(hk) ?? 0) + 1);
    if (d.status === "REVERSED") {
      const recall = d.verdict?.recall ?? null;
      const reason = recall ? `CPSC recall ${recall}` : d.verdict?.kind === "BANNED_TYPE" ? "Banned product type" : "Recall or ban";
      const key = `${reason}|${recall}`;
      const r = reasons.get(key) ?? { reason, recall, n: 0, usd: 0 };
      r.n++; r.usd = round2(r.usd + (d.amountUsd || 0));
      reasons.set(key, r);
    }
    if (d.status === "CAPTURED" || d.status === "REVERSED") {
      const done = [...(d.events ?? [])].reverse().find((e) => e.status === d.status);
      const t0 = Date.parse(d.createdAt), t1 = done ? Date.parse(done.at) : NaN;
      if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) seconds.push((t1 - t0) / 1000);
    }
  }
  seconds.sort((a, b) => a - b);
  const m = (x: number | null) => (x === null ? null : Math.round(x));
  return {
    asOf: now.toISOString(),
    deals: docs.length,
    byStatus,
    reversalReasons: [...reasons.values()].sort((a, b) => b.n - a.n),
    keptFromBadItemsUsd: byStatus.REVERSED?.usd ?? 0,
    decisionSeconds: { median: m(percentile(seconds, 50)), p90: m(percentile(seconds, 90)), n: seconds.length },
    bySource: { agent, person: docs.length - agent },
    byCard,
    hourly: [...hours.entries()].map(([hour, n]) => ({ hour, n })),
    payouts,
  };
}

export async function trustStats(): Promise<TrustStats | null> {
  const db = await getDb().catch(() => null);
  if (!db) return null;
  try {
    const docs = await db.collection<Doc>("deals")
      .find({}, { projection: { _id: 0, status: 1, amountUsd: 1, card: 1, agent: 1, createdAt: 1, events: 1, verdict: 1, payout: 1 }, sort: { createdAt: -1 }, limit: 2000, maxTimeMS: 5000 })
      .toArray();
    return summarize(docs);
  } catch (e) {
    console.warn("[trust] Atlas read failed:", (e as Error).message);
    return null;
  }
}
