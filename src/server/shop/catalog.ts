import doc from "../../../data/shop-listings.json";
import { checkLabel, isJunkId } from "@/server/recalls/match";
import type { ProductClass, VerdictKind } from "@/core/verdict";

/** The shopping agent's catalog: real eBay and Craigslist listings we harvested and scanned (ml/export_shop.py). */
export interface Listing {
  id: string; source: string; region: string | null; url: string; image: string | null; title: string; priceUsd: number | null;
  lat: number | null; lng: number | null; cls: ProductClass; p: number; review: { ok: string; note: string } | null;
}
export const CATALOG = (doc as unknown as { listings: Listing[] }).listings;
export const byId = new Map(CATALOG.map((l) => [l.id, l]));
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

const CLASS_LABEL: Partial<Record<ProductClass, string>> = {
  inclined_or_inbed_sleeper: "inclined or in-bed sleeper", crib_bumper: "padded crib bumper", drop_side_crib: "drop-side crib",
};

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
  // A person looked at this photo: their call outranks the model (yes = the flag was right, no = false alarm).
  const type = CLASS_LABEL[l.cls] ?? "banned type";
  if (l.review?.ok === "yes") {
    return { tone: "red", kind: "BANNED_TYPE", headline: "Banned type (reviewed by us)",
      reason: `A person on our team reviewed this photo and confirmed it: "${l.review.note}". The agent will not buy it.` };
  }
  if (l.review?.ok === "unsure") {
    return { tone: "amber", kind: "NEEDS_CHECK", headline: "Reviewed: unsure",
      reason: `A person on our team looked at this photo and could not tell ("${l.review.note}"). Check it at pickup.` };
  }
  const v = checkLabel({ text: l.title, cls: { cls: l.cls, p: l.p } });
  if (v.kind === "BANNED_TYPE") {
    if (l.review?.ok === "no") {
      return { tone: "amber", kind: "NEEDS_CHECK", headline: "Model flagged it; our review disagreed",
        reason: `The photo model saw a banned type, but a person reviewing it wrote "${l.review.note}". Check at pickup.` };
    }
    return { tone: "red", kind: v.kind, headline: "Banned type", reason: v.reason };
  }
  if (l.cls !== "other" && l.review?.ok !== "no") {
    // below the model's decision threshold: say it leaned that way instead of claiming the photo is clear
    return { tone: "amber", kind: "NEEDS_CHECK", headline: `Photo model unsure: leans ${type}`,
      reason: `Our photo model's best guess is ${/^[aeiou]/i.test(type) ? "an" : "a"} ${type} (${Math.round(l.p * 100)}%), below the level where it decides on its own. Look closely at pickup.` };
  }
  if (v.kind === "NEEDS_CHECK") return { tone: "amber", kind: v.kind, headline: "Needs a check", reason: v.reason };
  if (/car ?seat|booster/i.test(l.title)) {
    return { tone: "amber", kind: "NEEDS_CHECK", headline: "Car seat: needs NHTSA's used-seat check",
      reason: "Used car seats need the manufacture date, expiration, crash history and every part checked. The date is read from the seat label at pickup." };
  }
  return { tone: "clear", kind: "PHOTO_CLEAR", headline: "Photo check passed",
    reason: "Our photo model sees no banned product type and the title names no recalled model number. The label is still read at pickup before any money moves." };
}
