import type { VerdictKind } from "./verdict";

/**
 * What the table kiosk (/checkpoint) shows for one deal. The deal token is the same one /pickup holds: it is
 * signed on the server and only the server can verify it (POST /api/pickup checks it before Visa is called).
 * Reading its body here is for display only (which deal, what amount), never a decision.
 */

export type DealStatus = "HELD" | "CAPTURED" | "REVERSED" | "REFUSED" | "UNKNOWN" | "RELEASED" | "LAPSED";
export type KioskState = "IDLE" | "HELD" | "NEEDS_CHECK" | "CAPTURED" | "REVERSED" | "REFUSED" | "UNKNOWN" | "CLOSED";

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

/**
 * The deal record (MongoDB, written by whichever device settled) may move a HELD kiosk to a final status, never
 * the other way: a late or stale record never reopens a deal this kiosk saw settle.
 */
export function mergeRecord(local: DealStatus, record: DealStatus | undefined): DealStatus {
  if (!record || local !== "HELD") return local;
  return record;
}
