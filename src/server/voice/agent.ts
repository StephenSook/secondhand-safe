import { createHash, timingSafeEqual } from "node:crypto";
import type { ShopResult } from "@/server/shop/agent";

/**
 * Server side of the ElevenLabs conversational agent (PLAN 5.6). The browser never sees the API key: it asks
 * /api/voice-agent/session for a signed URL (valid about 15 minutes) and opens the conversation with that.
 * The agent's search tool is a webhook ElevenLabs calls from its own servers, authenticated by a shared secret.
 */

export const ELEVENLABS_API = "https://api.elevenlabs.io";

/** GET /v1/convai/conversation/get-signed-url?agent_id=... with the xi-api-key header -> { signed_url }. */
export async function mintSignedUrl(agentId: string, key: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = `${ELEVENLABS_API}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
  const res = await fetchImpl(url, { headers: { "xi-api-key": key }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const j = (await res.json().catch(() => null)) as { signed_url?: unknown } | null;
  if (typeof j?.signed_url !== "string" || !j.signed_url.startsWith("wss://")) throw new Error("ElevenLabs returned no signed URL.");
  return j.signed_url;
}

/**
 * True when the request comes from one of our own pages: the browser's Sec-Fetch-Site says same-origin, or (older
 * browsers) the Origin/Referer host equals the host being asked. A script can forge these headers, so this is a
 * speed bump in front of the per-IP and daily caps, not a security boundary.
 */
export function sameSiteRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const src = req.headers.get("origin") ?? req.headers.get("referer");
  if (!src) return false;
  try {
    return new URL(src).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

/** Constant-time compare of the webhook secret header. Hashing first keeps the compare length-independent. */
export function secretMatches(given: string | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const AGENT_MAX_USD = 200;

/** Plain words the agent can say out loud. Never "safe": the best a listing gets is "photo check passed". */
const PLAIN: Record<string, string> = {
  RECALL_MATCH: "recalled: refused, the agent will not hold it",
  BANNED_TYPE: "banned product type: refused, the agent will not hold it",
  NEEDS_CHECK: "needs a check: look at the label at pickup",
  UNREADABLE: "needs a check: look at the label at pickup",
  NO_MATCH: "photo check passed: the label is still read at pickup",
  PHOTO_CLEAR: "photo check passed: the label is still read at pickup",
};

/**
 * The agent reads this aloud, so the word never reaches it: the law's name (the only place it appears in our
 * verdict reasons) becomes "federal law", and a seller's own title loses the word rather than have it spoken.
 */
const unsafeWordFree = (s: string) =>
  s.replace(/the Safe Sleep for Babies Act/g, "federal law").replace(/\bsafe\b/gi, "").replace(/\s{2,}/g, " ").trim();

export interface SpokenListing {
  id: string;
  title: string;
  priceUsd: number | null;
  place: string;
  verdict: string;
  tone: "red" | "amber" | "clear";
  reason?: string;
  canHold: boolean;
}

export interface SpokenResult {
  query: string;
  engine: ShopResult["engine"];
  found: number;
  counts: { refused: number; needCheck: number; photoCheckPassed: number };
  top: SpokenListing[];
  note: string;
}

/** Top 3 of the same pre-screened search /api/shop runs, cut down to what can be read aloud. */
export function speakable(query: string, r: ShopResult): SpokenResult {
  const top = r.results.slice(0, 3).map(({ listing: l, screen: s }): SpokenListing => {
    const price = l.priceUsd;
    const item: SpokenListing = {
      id: l.id,
      title: unsafeWordFree(l.title.slice(0, 90)),
      priceUsd: price,
      place: l.source === "ebay" ? "eBay, shipped" : `Craigslist ${l.region ?? ""}`.trim(),
      verdict: PLAIN[s.kind] ?? "needs a check: look at the label at pickup",
      tone: s.tone,
      canHold: s.tone !== "red" && price != null && price >= 1 && price <= AGENT_MAX_USD,
    };
    if (s.tone !== "clear") item.reason = unsafeWordFree(s.reason).slice(0, 280);
    return item;
  });
  return {
    query: unsafeWordFree(query),
    engine: r.engine,
    found: r.results.length,
    counts: { refused: r.counts.red, needCheck: r.counts.amber, photoCheckPassed: r.counts.clear },
    top,
    note: "Pre-screened against CPSC and NHTSA recalls, our photo model and our own review. A verdict is a screen, not a guarantee, and nothing is paid until the label passes at pickup. The parent taps the hold button; you never take payment.",
  };
}
