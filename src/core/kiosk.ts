import type { VerdictKind } from "./verdict";

/**
 * What the table kiosk (/checkpoint) shows for one deal. The deal token is the same one /pickup holds: it is
 * signed on the server and only the server can verify it (POST /api/pickup checks it before Visa is called).
 * Reading its body here is for display only (which deal, what amount), never a decision.
 */

export type DealStatus = "HELD" | "CAPTURED" | "REVERSED" | "REFUSED" | "UNKNOWN" | "RELEASED" | "LAPSED";
/** SETTLING: another device holds the one-settlement claim for this deal right now (409); nothing sent from here. */
export type KioskState = "IDLE" | "HELD" | "NEEDS_CHECK" | "SETTLING" | "CAPTURED" | "REVERSED" | "REFUSED" | "UNKNOWN" | "CLOSED";

export interface TokenView { token: string; dealId: string; amountUsd: number; issuedAt: number }

const DEAL_ID = /^shs-[0-9a-f-]{8,24}$/;

function b64urlToString(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Finds a deal token in pasted text (the bare token, or any text containing it) and reads its unverified body. */
export function readDealToken(text: string): TokenView | null {
  const candidates = text.match(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g) ?? [];
  for (const token of candidates) {
    try {
      const c = JSON.parse(b64urlToString(token.split(".")[0])) as { dealId?: unknown; amountUsd?: unknown; iat?: unknown };
      if (typeof c.dealId === "string" && DEAL_ID.test(c.dealId) && typeof c.amountUsd === "number" && typeof c.iat === "number") {
        return { token, dealId: c.dealId, amountUsd: c.amountUsd, issuedAt: c.iat };
      }
    } catch {
      // not a deal token; try the next candidate
    }
  }
  return null;
}

/** A hold kept after a scan (NEEDS_CHECK, UNREADABLE) is its own state: the money is still held, a person decides. */
export function kioskState(status: DealStatus | null, verdict?: VerdictKind | null): KioskState {
  if (!status) return "IDLE";
  if (status === "HELD") return verdict === "NEEDS_CHECK" || verdict === "UNREADABLE" ? "NEEDS_CHECK" : "HELD";
  if (status === "RELEASED" || status === "LAPSED") return "CLOSED";
  return status;
}

/** Only an open hold can be settled from the kiosk; every other state (including UNKNOWN: money may have moved) is final here. */
export const canSettle = (status: DealStatus | null) => status === "HELD";

const FINAL: ReadonlySet<DealStatus> = new Set(["CAPTURED", "REVERSED", "RELEASED", "LAPSED"]);

/**
 * The deal record (MongoDB, written by whichever request settled at Visa) against what this kiosk knows:
 * - a HELD kiosk takes any settled record (another device settled it);
 * - an UNKNOWN or REFUSED kiosk (a lost answer, or the loser of a race) takes an authoritative FINAL record,
 *   so a confirmed capture or reversal resolves the uncertainty;
 * - nothing ever goes back to HELD, and a final status is never replaced.
 */
export function mergeRecord(local: DealStatus, record: DealStatus | undefined): DealStatus {
  if (!record || record === "HELD" || record === local) return local;
  if (local === "HELD") return record;
  if ((local === "UNKNOWN" || local === "REFUSED") && FINAL.has(record)) return record;
  return local;
}

/** A record answer applies only to the deal it was asked for, while that deal is still the one attached. */
export function recordApplies(askedFor: string, attached: string | undefined, record: { dealId?: string } | null): boolean {
  return !!attached && askedFor === attached && (!record || record.dealId === askedFor);
}
