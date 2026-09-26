import { checkLabel, fold } from "@/server/recalls/match";
import type { SaleLabel } from "@/server/deals/store";

/**
 * Recall watch (PLAN 6.2): a recall can be announced AFTER a parent bought the item. Every captured sale keeps the
 * label its pickup scan read, and is re-checked:
 *  - for real, against the current recall index (runs daily; a sale matches when the index gained a recall for it);
 *  - as a labelled simulation, against a hypothetical recall a judge types in ("what if CPSC announced a recall for
 *    model X tomorrow?"). A simulation is never written to a deal; it only shows which real sales would be caught.
 */
export interface Sale { _id: string; listing: string; label?: SaleLabel | null; postSaleRecall?: { recallNumber: string } | null }
export interface RealHit { dealId: string; listing: string; recallNumber: string; title: string; url: string; reason: string }
export interface SimHit { dealId: string; listing: string; matchedModel: string; batchCheck: "matches" | "not printed on the label: read it" }

/** Sales whose label now matches a recall in the current index (the real, daily path). */
export function recheckSales(sales: Sale[]): RealHit[] {
  const hits: RealHit[] = [];
  for (const s of sales) {
    const l = s.label;
    if (!l || (!l.model && !l.upc)) continue;
    const v = checkLabel({ model: l.model ?? undefined, batch: l.batch ?? undefined, date: l.date ?? undefined, upc: l.upc ?? undefined });
    if (v.kind === "RECALL_MATCH" && v.recall && s.postSaleRecall?.recallNumber !== v.recall.recallNumber) {
      hits.push({ dealId: s._id, listing: s.listing, recallNumber: v.recall.recallNumber, title: v.recall.title, url: v.recall.url, reason: v.reason });
    }
  }
  return hits;
}

/** A hypothetical recall typed for the demo: a model number, optionally the recalled batches. */
export function parseHypothetical(b: unknown): { model: string; batches: string[] } | null {
  const o = b as { model?: unknown; batch?: unknown } | null;
  const model = typeof o?.model === "string" ? o.model.replace(/[^A-Za-z0-9 -]/g, "").trim().slice(0, 40) : "";
  if (fold(model).length < 4) return null;
  const batches = typeof o?.batch === "string" && o.batch.trim() ? o.batch.split(",").map((x) => x.replace(/[^A-Za-z0-9 -]/g, "").trim().slice(0, 30)).filter(Boolean).slice(0, 10) : [];
  return { model, batches };
}

/** Which real sales a hypothetical recall would catch: same model (with the matcher's O/0 and I/1 folding), and the
 *  batch when the recall names batches (a missing batch on the label means "read it", never "clear"). */
export function simulateRecall(sales: Sale[], h: { model: string; batches: string[] }): SimHit[] {
  const want = fold(h.model);
  const batches = h.batches.map(fold);
  const hits: SimHit[] = [];
  for (const s of sales) {
    const m = s.label?.model;
    if (!m || fold(m) !== want) continue;
    const b = s.label?.batch ? fold(s.label.batch) : null;
    if (batches.length && b && !batches.includes(b)) continue; // a different batch is not in this recall
    hits.push({ dealId: s._id, listing: s.listing, matchedModel: m, batchCheck: batches.length && !b ? "not printed on the label: read it" : "matches" });
  }
  return hits;
}
