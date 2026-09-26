/** Shared verdict contract (PLAN Shared Contracts). The vocabulary never says "safe" (PLAN D2). */

export type VerdictKind = "RECALL_MATCH" | "BANNED_TYPE" | "NO_MATCH" | "UNREADABLE" | "NEEDS_CHECK";

export type ProductClass = "inclined_or_inbed_sleeper" | "crib_bumper" | "drop_side_crib" | "other";

export interface Identifier {
  kind: "model" | "batch" | "upc";
  value: string;
  found_by: string[];
}

export interface RecallDoc {
  source: "CPSC" | "NHTSA";
  recallNumber: string;
  recallDate: string;
  title: string;
  url: string;
  products: string[];
  brands: string[];
  productType: string;
  hazard: string;
  remedy: string;
  units: string;
  images: string[];
  identifiers: Identifier[];
  /** NHTSA child-seat campaigns: recalled manufacture date range, YYYYMMDD. */
  mfgRange?: { from: string; to: string } | null;
}

export interface Verdict {
  kind: VerdictKind;
  recall?: RecallDoc;
  reason: string;
  asOf: string;
  matched?: { field: "model" | "upc"; value: string; recallValue: string };
}

/** Moves the money: only these verdicts may capture. Everything else reverses or waits for a human. */
export const CAPTURABLE: ReadonlySet<VerdictKind> = new Set(["NO_MATCH"]);

export const VERDICT_LABEL: Record<VerdictKind, string> = {
  RECALL_MATCH: "Recalled",
  BANNED_TYPE: "Banned product type",
  NO_MATCH: "No recall match",
  UNREADABLE: "Label unreadable",
  NEEDS_CHECK: "Needs a check",
};
