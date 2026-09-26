import type { Verdict } from "@/core/verdict";
import { capture, reverse, type VisaCreds, type VisaResult } from "@/server/visa/acceptance";

/**
 * REFUSED: Visa rejected the settlement (in the sandbox a second capture, or a reversal after capture, comes
 * back 400 MISSING_AUTH: the hold was already settled or is not open). UNKNOWN: Visa did not answer.
 * Neither is ever reported as HELD, CAPTURED or REVERSED.
 */
export type DealStatus = "HELD" | "CAPTURED" | "REVERSED" | "REFUSED" | "UNKNOWN";

/**
 * The money rule (PLAN D1, D3): only NO_MATCH captures; a recall match or banned type reverses; anything
 * uncertain (NEEDS_CHECK, UNREADABLE) keeps the hold and moves no money.
 */
export function decide(v: Verdict): "capture" | "reverse" | "hold" {
  if (v.kind === "NO_MATCH") return "capture";
  if (v.kind === "RECALL_MATCH" || v.kind === "BANNED_TYPE") return "reverse";
  return "hold";
}

/** REFUSED only when Visa itself answered 4xx with a status (it did not apply the action). A 2xx outside the
 *  allowlist, a body that could not be read, a 5xx or no answer is UNKNOWN: money may have moved. */
const unconfirmed = (r: VisaResult): DealStatus => (r.parsed && r.httpStatus >= 400 && r.httpStatus < 500 ? "REFUSED" : "UNKNOWN");

export async function settle(
  creds: VisaCreds,
  deal: { dealId: string; authId: string; amountUsd: number },
  v: Verdict,
  f?: typeof fetch,
): Promise<{ status: DealStatus; visa?: VisaResult }> {
  const action = decide(v);
  if (action === "hold") return { status: "HELD" };
  if (action === "capture") {
    const r = await capture(creds, deal.authId, deal, f);
    return { status: r.ok ? "CAPTURED" : unconfirmed(r), visa: r };
  }
  const reason = v.recall ? `CPSC recall ${v.recall.recallNumber} at pickup` : "Banned product type at pickup";
  const r = await reverse(creds, deal.authId, { ...deal, reason }, f);
  return { status: r.ok ? "REVERSED" : unconfirmed(r), visa: r };
}
