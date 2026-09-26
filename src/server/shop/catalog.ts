import doc from "../../../data/shop-listings.json";
import { checkLabel, isJunkId } from "@/server/recalls/match";
import type { ProductClass, VerdictKind } from "@/core/verdict";

/** The shopping agent's catalog: real eBay and Craigslist listings we harvested and scanned (ml/export_shop.py). */
export interface Listing {
  id: string; source: string; region: string | null; url: string; image: string | null; title: string; priceUsd: number | null;
  lat: number | null; lng: number | null; cls: ProductClass; p: number; review: { ok: string; note: string } | null;
}
export const CATALOG = (doc as unknown as { listings: Listing[] }).listings;
export const CATALOG_SOURCE = (doc as unknown as { source: string }).source;

export interface Intent { terms: string[]; maxPriceUsd: number | null; minPriceUsd: number | null; atlantaOnly: boolean }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
const stem = (w: string) => w.replace(/(ies|es|s)$/, "");

export function search(intent: Intent, limit = 10): Listing[] {
  const terms = [...new Set(intent.terms.map((t) => stem(norm(t).trim())).filter((t) => t.length >= 3))].slice(0, 12);
  const scored = CATALOG.flatMap((l) => {
    if (intent.atlantaOnly && l.region !== "atlanta") return [];
    const price = l.priceUsd ?? 0;
    if (intent.maxPriceUsd != null && (price <= 0 || price > intent.maxPriceUsd)) return [];
    if (intent.minPriceUsd != null && price < intent.minPriceUsd) return [];
    const words = norm(l.title).split(/\s+/).map(stem);
    const hay = ` ${words.join(" ")} `;
    const score = terms.filter((t) => (t.includes(" ") ? hay.includes(` ${t} `) : words.includes(t))).length;
    return terms.length && score === 0 ? [] : [{ l, score }];
  });
  scored.sort((a, b) => b.score - a.score || (a.l.priceUsd ?? 0) - (b.l.priceUsd ?? 0));
  return scored.slice(0, limit).map((s) => s.l);
}

export type Screen = { tone: "red" | "amber" | "clear"; kind: VerdictKind | "PHOTO_CLEAR"; headline: string; reason: string };

/**
 * Pre-screen before anyone messages the seller: any model number in the title against the recall index, the
 * listing photo's banned-type result, and our own review of that photo when a person looked at it. Never "safe":
 * the best a listing gets is "photo check passed", and the label is still checked at pickup.
 */
export function prescreen(l: Listing): Screen {
  for (const tok of l.title.match(/\b[A-Za-z0-9][A-Za-z0-9-]{3,}\b/g) ?? []) {
    if (!/\d/.test(tok) || isJunkId(tok)) continue;
    const v = checkLabel({ model: tok, text: l.title });
    if (v.kind === "RECALL_MATCH") return { tone: "red", kind: v.kind, headline: "Recalled", reason: v.reason };
    if (v.kind === "NEEDS_CHECK" && v.recall) return { tone: "amber", kind: v.kind, headline: "Possible recall", reason: v.reason };
  }
  const v = checkLabel({ text: l.title, cls: { cls: l.cls, p: l.p } });
  if (v.kind === "BANNED_TYPE") {
    if (l.review?.ok === "no") {
      return { tone: "amber", kind: "NEEDS_CHECK", headline: "Model flagged it; our review disagreed",
        reason: `The photo model saw a banned type, but a person reviewing it wrote "${l.review.note}". Check at pickup.` };
    }
    return { tone: "red", kind: v.kind, headline: "Banned type", reason: v.reason };
  }
  if (v.kind === "NEEDS_CHECK") return { tone: "amber", kind: v.kind, headline: "Needs a check", reason: v.reason };
  if (/car ?seat|booster/i.test(l.title)) {
    return { tone: "amber", kind: "NEEDS_CHECK", headline: "Car seat: needs NHTSA's used-seat check",
      reason: "Used car seats need the manufacture date, expiration, crash history and every part checked. The date is read from the seat label at pickup." };
  }
  return { tone: "clear", kind: "PHOTO_CLEAR", headline: "Photo check passed",
    reason: "No banned type in the photo and no recalled model number in the title. The label is still read at pickup before any money moves." };
}
