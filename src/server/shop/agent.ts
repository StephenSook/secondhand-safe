import { geminiJson } from "@/server/ml/gemini";
import { search, prescreen, type Intent, type Listing, type Screen } from "./catalog";

/**
 * The shopping agent: Gemini turns what the parent says into search filters, the catalog of real scanned
 * listings is searched, and every result is pre-screened before the parent ever messages a seller.
 * Gemini never judges safety; the verdicts come from the recall index, the trained model and human review.
 */
const INTENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    terms: { type: "ARRAY", items: { type: "STRING" }, description: "2 to 8 lowercase words or two-word phrases a matching listing title would contain, including common synonyms (for example bassinet, bedside sleeper, co-sleeper)" },
    maxPriceUsd: { type: "NUMBER", description: "Upper price limit in USD, or 0 if none was given" },
    minPriceUsd: { type: "NUMBER", description: "Lower price limit in USD, or 0 if none was given" },
    atlantaOnly: { type: "BOOLEAN", description: "True if the parent wants local pickup in or near Atlanta" },
    reply: { type: "STRING", description: "One short friendly sentence saying what you will look for. Never call any product safe." },
  },
  required: ["terms", "maxPriceUsd", "minPriceUsd", "atlantaOnly", "reply"],
};

const prompt = (q: string) => `You help a parent shop for used baby gear on secondhand marketplaces in Atlanta.
Turn their request into search filters for listing titles. Only extract what they asked for; do not invent a budget.
Parent: """${q.slice(0, 400)}"""`;

export interface ShopResult {
  engine: "gemini" | "keywords";
  reply: string;
  intent: Intent;
  results: { listing: Listing; screen: Screen }[];
  counts: { red: number; amber: number; clear: number };
}

/** Used only when Gemini is not reachable, and the response says so. */
export function keywordIntent(q: string): Intent {
  const s = q.toLowerCase();
  const max = s.match(/(?:under|below|less than|max|<)\s*\$?\s*(\d{1,4})/);
  const stop = new Set(["under", "below", "less", "than", "near", "for", "the", "and", "with", "baby", "a", "an", "in", "my", "need", "want", "looking", "used", "cheap", "midtown", "atlanta", "atl"]);
  const terms = s.replace(/\$?\d+/g, " ").split(/[^a-z-]+/).filter((w) => w.length >= 3 && !stop.has(w)).slice(0, 6);
  return { terms, maxPriceUsd: max ? Number(max[1]) : null, minPriceUsd: null, atlantaOnly: /atlanta|atl\b|midtown|decatur|marietta|near me|local|pick ?up/.test(s) };
}

export function screenAll(intent: Intent) {
  const results = search(intent, 10).map((listing) => ({ listing, screen: prescreen(listing) }));
  const counts = { red: 0, amber: 0, clear: 0 };
  for (const r of results) counts[r.screen.tone] += 1;
  return { results, counts };
}

export async function shop(q: string, key: string | null, f?: typeof fetch): Promise<ShopResult> {
  if (key) {
    try {
      const g = await geminiJson<{ terms: string[]; maxPriceUsd: number; minPriceUsd: number; atlantaOnly: boolean; reply: string }>(key, prompt(q), INTENT_SCHEMA, f);
      const intent: Intent = {
        terms: (g.terms ?? []).map(String).slice(0, 8),
        maxPriceUsd: g.maxPriceUsd > 0 ? g.maxPriceUsd : null,
        minPriceUsd: g.minPriceUsd > 0 ? g.minPriceUsd : null,
        atlantaOnly: !!g.atlantaOnly,
      };
      const reply = /\bsafe\b/i.test(g.reply ?? "") ? "Here is what I found, each one pre-screened." : String(g.reply ?? "").slice(0, 200);
      return { engine: "gemini", reply, intent, ...screenAll(intent) };
    } catch {
      // fall through to the labelled keyword search
    }
  }
  const intent = keywordIntent(q);
  return { engine: "keywords", reply: "Gemini is not reachable right now, so this is a plain keyword search.", intent, ...screenAll(intent) };
}
