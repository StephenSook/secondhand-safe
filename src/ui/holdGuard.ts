/**
 * One open hold at a time, across every page that can create one (/shop and /pickup).
 *
 * `shs-deal` is a confirmed hold the pickup page settles. `shs-pending` is written BEFORE every hold attempt and
 * cleared only when the server says explicitly that no hold was placed (`placed: false`) or when the hold is
 * confirmed; a lost or ambiguous answer (a hold MAY exist) keeps it, and it blocks every new hold until the parent
 * clears it. The server also releases what it can (over- and partial authorizations); this covers the rest.
 */
export const DEAL_KEY = "shs-deal";
export const PENDING_KEY = "shs-pending";

export type Held = { id: string; handoff: boolean; text: string; pending?: boolean };
type Stored = { dealId?: string; listing?: string; listingId?: string; amountUsd?: number; status?: string };

const read = (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const parse = (raw: string) => { try { return JSON.parse(raw || "null") as Stored | null; } catch { return null; } };

/** Snapshot of both keys as one string (stable for useSyncExternalStore). */
export const readBoth = () => `${read(DEAL_KEY) ?? ""}\n${read(PENDING_KEY) ?? ""}`;
export const noSubscribe = () => () => {};

/** The unsettled hold this browser carries, from a snapshot: an open deal first, then a pending attempt. */
export function openHold(raw: string = readBoth()): Held | null {
  const [dealRaw, pendingRaw] = raw.split("\n");
  const d = parse(dealRaw);
  if (d?.dealId && (d.status === "HELD" || d.status === "UNKNOWN")) {
    return { id: d.listingId ?? "", handoff: true,
      text: `You already have an open hold: $${(d.amountUsd ?? 0).toFixed(2)} for ${d.listing ?? "a listing"}. Finish it at pickup before holding another.` };
  }
  const p = parse(pendingRaw);
  if (p?.listingId) {
    return { id: p.listingId, handoff: false, pending: true,
      text: `Visa did not confirm the hold for ${p.listing ?? "a listing"} ($${(p.amountUsd ?? 0).toFixed(2)}), so one MAY exist. It lapses on its own if nobody captures it. No second hold until you clear this.` };
  }
  return null;
}

/** Writes the pending marker; false when the browser refuses storage (the caller must then not call checkout). */
export function markPending(p: { listingId: string; listing: string; amountUsd: number }): boolean {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ listingId: p.listingId, listing: p.listing.slice(0, 80), amountUsd: p.amountUsd }));
    return true;
  } catch {
    return false;
  }
}

export function clearPending() {
  try { sessionStorage.removeItem(PENDING_KEY); } catch {}
}

/** True only when a checkout answer says explicitly that no hold was placed. */
export function explicitlyNoHold(body: unknown): boolean {
  const b = body as { placed?: unknown; merchant?: { placed?: unknown } } | null;
  return b?.merchant ? b.merchant.placed === false : b?.placed === false;
}

export const STORAGE_BLOCKED = "This browser is blocking site storage, so we cannot guarantee one hold at a time. Nothing was held. Allow site data for this page and try again.";
