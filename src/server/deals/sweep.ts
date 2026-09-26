import { reverse, type VisaCreds, type VisaResult } from "@/server/visa/acceptance";
import { TTL_MS } from "@/server/deals/token";

/**
 * Hold sweeper (PLAN 5.4): a pickup that never happens must not leave a parent's money held. Once a day
 * (Vercel cron) every hold older than the window is released at Visa with a full reversal.
 *
 * RELEASED: Visa confirmed the reversal. LAPSED: the hold was recorded before deals stored their Visa
 * authorization id, so we cannot reverse it by API; a card authorization that is never captured expires at
 * Visa on its own, and the record says exactly that. A reversal Visa did not confirm leaves the deal HELD
 * (it is retried on the next run) or marks it REFUSED when Visa said the hold is no longer open.
 */
const envHours = Number(process.env.HOLD_WINDOW_HOURS);
// Never shorter than the pickup token's life (+1 h): a hold the buyer can still settle is never swept.
const MIN_HOURS = TTL_MS / 3_600_000 + 1;
export const HOLD_WINDOW_HOURS = Math.max(Number.isFinite(envHours) && envHours > 0 ? envHours : 24, MIN_HOURS);

export interface HeldDeal { _id: string; amountUsd: number; createdAt: string; authId?: string | null }
export type SweepAction = { dealId: string; amountUsd: number } & ({ action: "reverse"; authId: string } | { action: "lapse" });
export type SweepOutcome = { dealId: string; status: "RELEASED" | "LAPSED" | "REFUSED" | "UNKNOWN"; note: string };

/** Which held deals are past the window, and what to do with each. Pure, so it is tested without Atlas or Visa. */
export function planSweep(held: HeldDeal[], now: Date, windowHours = HOLD_WINDOW_HOURS): SweepAction[] {
  const cutoff = now.getTime() - windowHours * 3_600_000;
  return held
    .filter((d) => Number.isFinite(Date.parse(d.createdAt)) && Date.parse(d.createdAt) < cutoff)
    .map((d) => (d.authId ? { action: "reverse", dealId: d._id, amountUsd: d.amountUsd, authId: d.authId } : { action: "lapse", dealId: d._id, amountUsd: d.amountUsd }));
}

/** Visa's answer to a sweep reversal, in the deal vocabulary. Only a readable 4xx is REFUSED (hold not open). */
export function sweepOutcome(dealId: string, r: VisaResult): SweepOutcome {
  if (r.ok) return { dealId, status: "RELEASED", note: "Pickup never happened: Visa reversed the hold, nothing was charged" };
  if (r.parsed && r.httpStatus >= 400 && r.httpStatus < 500) {
    return { dealId, status: "REFUSED", note: `Visa says this hold is no longer open (${r.reason ?? r.status}); nothing to release` };
  }
  return { dealId, status: "UNKNOWN", note: "Visa did not confirm the release; the deal stays held and is retried on the next sweep" };
}

/**
 * Runs the plan one deal at a time and hands each outcome to `record` IMMEDIATELY, so a function timeout never
 * leaves a reversal Visa applied without its record. Stops starting new reversals at `deadline` (epoch ms);
 * the rest wait for the next run.
 */
export async function runSweep(creds: VisaCreds, plan: SweepAction[], opts: { record?: (o: SweepOutcome) => Promise<unknown>; deadline?: number; f?: typeof fetch } = {}): Promise<SweepOutcome[]> {
  const out: SweepOutcome[] = [];
  for (const a of plan) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    const o: SweepOutcome = a.action === "lapse"
      ? { dealId: a.dealId, status: "LAPSED", note: "Recorded before deals stored their Visa authorization id; an uncaptured authorization expires at Visa on its own, nothing was charged" }
      : sweepOutcome(a.dealId, await reverse(creds, a.authId, { dealId: a.dealId, amountUsd: a.amountUsd, reason: "pickup never happened" }, opts.f));
    if (opts.record) await opts.record(o);
    out.push(o);
  }
  return out;
}
