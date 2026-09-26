import { publicListing } from "@/server/deals/store";

/**
 * What the recall call says, and the Vonage Call Control Object (NCCO) that says it. The words are built only from
 * the deal record (our own listing titles, the amount, the CPSC recall number): caller-typed text is never spoken.
 */
export type CallReason =
  | { kind: "reversed"; verdict: "RECALL_MATCH" | "BANNED_TYPE"; recallNumber: string | null }
  | { kind: "postsale"; recallNumber: string };

export const reasonKey = (r: CallReason) => (r.kind === "reversed" ? "reversed" : `postsale:${r.recallNumber}`);

const RECALL_NO = /^[A-Za-z0-9-]{2,20}$/;

/** "26-061" is read as "26, 061" so a phone voice does not say "minus" or a date. */
const spokenRecall = (n: string) => n.replace(/-/g, ", ");

export function callScript(r: CallReason, deal: { listing: string; amountUsd: number }): string {
  const shown = publicListing(deal.listing);
  const item = shown === "A listing" ? "item" : shown;
  const amount = Number.isFinite(deal.amountUsd) ? `$${deal.amountUsd.toFixed(2)}` : "payment";
  if (r.kind === "postsale") {
    const n = RECALL_NO.test(r.recallNumber) ? `CPSC recall ${spokenRecall(r.recallNumber)}` : "a CPSC recall";
    return `This is Lullabuy. The ${item} you bought now matches ${n}, announced after your purchase. Stop using it, and read the recall notice for the remedy.`;
  }
  const why = r.verdict === "RECALL_MATCH" && r.recallNumber && RECALL_NO.test(r.recallNumber)
    ? `matches CPSC recall ${spokenRecall(r.recallNumber)}`
    : r.verdict === "RECALL_MATCH" ? "matches a CPSC recall" : "is a type of baby product that is banned from sale";
  return `This is Lullabuy. The ${item} you're picking up ${why}. Your ${amount} hold was reversed. You were not charged.`;
}

export const MAX_REPLAYS = 2;

export type NccoAction = Record<string, unknown> & { action: "stream" | "talk" | "input" };

/**
 * Plays the verdict (an ElevenLabs MP3 when one was made, else Vonage's own text-to-speech), then offers
 * "press 1 to hear it again" up to MAX_REPLAYS times. Without an inputUrl the call simply ends after the verdict.
 */
export function buildNcco(o: { text: string; audioUrl?: string | null; inputUrl?: string | null; replays: number }): NccoAction[] {
  const offer = !!o.inputUrl && o.replays < MAX_REPLAYS;
  const verdict: NccoAction = o.audioUrl
    ? { action: "stream", streamUrl: [o.audioUrl] }
    : { action: "talk", text: o.text, language: "en-US" };
  if (!offer) return [verdict, { action: "talk", text: "Goodbye.", language: "en-US" }];
  return [
    verdict,
    { action: "talk", text: "Press 1 to hear this again.", language: "en-US", bargeIn: true },
    { action: "input", type: ["dtmf"], dtmf: { maxDigits: 1, timeOut: 6 }, eventUrl: [o.inputUrl], eventMethod: "POST" },
  ];
}
