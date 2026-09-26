import recallsJson from "../../../data/recalls.json";
import statsJson from "../../../data/recall_stats.json";
import type { ProductClass, RecallDoc, Verdict } from "@/core/verdict";

/**
 * Recall matcher (PLAN 1.3) over the index built by data/build_recall_index.py from the CPSC recall API.
 * Order of precedence: a recall match beats a banned type, which beats a type that needs a check.
 */

const RECALLS = recallsJson as unknown as RecallDoc[];
export const INDEX_AS_OF: string = (statsJson as { asOf: string }).asOf.slice(0, 10);
const MIN_MODEL_LEN = 4;
const CLASS_MIN_P = 0.6;

/** Case, punctuation and OCR look-alike folding: O->0, I/L->1 (PLAN 1.3). */
export function fold(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** Description-shaped tokens that are never model numbers: "4-in-1", "6-piece", "4-drawer", years, short numbers. */
const JUNK = /^(?:(?:19|20)\d\d|\d{1,3}|\d+-?(?:in-?1|in-?one|pieces?|pc|pack|drawers?|seats?|ft|in|inch(?:es)?|lbs?|oz|mm|cm|months?|mos?|years?|yrs?|ct|count))$/i;
export const isJunkId = (v: string) => JUNK.test(v.trim());

type Entry = { recall: RecallDoc; value: string };
const byModel = new Map<string, Entry[]>();
const byUpc = new Map<string, Entry[]>();
for (const r of RECALLS) {
  for (const id of r.identifiers) {
    if (id.kind === "model") {
      if (isJunkId(id.value)) continue;
      const k = fold(id.value);
      if (k.length >= MIN_MODEL_LEN) byModel.set(k, [...(byModel.get(k) ?? []), { recall: r, value: id.value }]);
    } else if (id.kind === "upc") {
      const k = id.value.replace(/\D/g, "");
      if (k.length >= 11) byUpc.set(k, [...(byUpc.get(k) ?? []), { recall: r, value: id.value }]);
    }
  }
}

export const INDEX_SIZE = { recalls: RECALLS.length, models: byModel.size, upcs: byUpc.size };

export interface LabelInput {
  model?: string;
  batch?: string;
  upc?: string;
  /** Free text read from the label or listing (used for mesh-liner and car-seat rules). */
  text?: string;
  cls?: { cls: ProductClass; p: number };
}

const batchesOf = (r: RecallDoc) => r.identifiers.filter((i) => i.kind === "batch").map((i) => i.value);

function recallVerdict(entry: Entry, field: "model" | "upc", value: string, batch?: string): Verdict {
  const r = entry.recall;
  const batches = batchesOf(r);
  const matched = { field, value, recallValue: entry.value };
  if (field === "model" && batches.length) {
    if (!batch?.trim()) {
      return { kind: "NEEDS_CHECK", recall: r, matched, asOf: INDEX_AS_OF,
        reason: `Model ${entry.value} is recalled only in batch ${batches.join(", ")} (CPSC ${r.recallNumber}). Read the batch code on the label.` };
    }
    if (!batches.some((b) => fold(b) === fold(batch))) {
      return { kind: "NEEDS_CHECK", recall: r, matched, asOf: INDEX_AS_OF,
        reason: `Model ${entry.value} is recalled only in batch ${batches.join(", ")}; this label reads ${batch}. Confirm the batch before paying.` };
    }
  }
  return { kind: "RECALL_MATCH", recall: r, matched, asOf: INDEX_AS_OF,
    reason: `${field === "model" ? "Model" : "UPC"} ${entry.value} matches CPSC recall ${r.recallNumber}: ${r.title}` };
}

const pick = (entries: Entry[]) => [...entries].sort((a, b) => b.recall.recallDate.localeCompare(a.recall.recallDate))[0];

export function checkLabel(input: LabelInput): Verdict {
  const text = (input.text ?? "").toLowerCase();
  if (input.upc) {
    const hit = byUpc.get(input.upc.replace(/\D/g, ""));
    if (hit) return recallVerdict(pick(hit), "upc", input.upc, input.batch);
  }
  if (input.model && fold(input.model).length >= MIN_MODEL_LEN && !isJunkId(input.model)) {
    const hit = byModel.get(fold(input.model));
    if (hit) return recallVerdict(pick(hit), "model", input.model, input.batch);
  }
  const c = input.cls && input.cls.p >= CLASS_MIN_P ? input.cls.cls : undefined;
  if (c === "crib_bumper") {
    if (/mesh/.test(text)) {
      return { kind: "NEEDS_CHECK", asOf: INDEX_AS_OF,
        reason: "Looks like a crib liner. Padded crib bumpers are banned; breathable mesh liners are allowed. Check which it is." };
    }
    return { kind: "BANNED_TYPE", asOf: INDEX_AS_OF,
      reason: "Padded crib bumpers are banned from sale under the Safe Sleep for Babies Act, whatever their manufacture date." };
  }
  if (c === "drop_side_crib") {
    return { kind: "BANNED_TYPE", asOf: INDEX_AS_OF,
      reason: "Drop-side cribs, and cribs made before June 28, 2011 that do not meet the current standard, cannot be resold." };
  }
  if (c === "inclined_or_inbed_sleeper") {
    if (/inclin|rock\W*n\W*play|rocking sleeper|rock n play/.test(text)) {
      return { kind: "BANNED_TYPE", asOf: INDEX_AS_OF,
        reason: "Inclined infant sleepers are banned from sale under the Safe Sleep for Babies Act." };
    }
    return { kind: "NEEDS_CHECK", asOf: INDEX_AS_OF,
      reason: "Looks like an infant sleeper. Inclined sleepers are banned; an in-bed sleeper must meet the bassinet standard. Check the type and the label." };
  }
  const read = !!(input.model?.trim() || input.upc?.trim());
  if (!read) {
    return { kind: "UNREADABLE", asOf: INDEX_AS_OF,
      reason: "No model number or UPC could be read. Photograph the label (usually on the back or underside) or type the model number." };
  }
  if (/car seat|carseat|booster/.test(text)) {
    return { kind: "NEEDS_CHECK", asOf: INDEX_AS_OF,
      reason: `No CPSC recall match as of ${INDEX_AS_OF}. Car seats also need NHTSA's used-seat check: expiration date, crash history, all parts and the label.` };
  }
  return { kind: "NO_MATCH", asOf: INDEX_AS_OF,
    reason: `No match in ${INDEX_SIZE.recalls} CPSC nursery and children's recalls as of ${INDEX_AS_OF}.` };
}
