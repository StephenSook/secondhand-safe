import { pushFunds, type PayoutResult, type PushDeps } from "@/server/visa/direct";
import { recordPayout } from "./store";

/**
 * After a CAPTURE: push the captured amount to the seller with Visa Direct, then put the outcome on the deal's
 * timeline. Runs in waitUntil, after the Visa Acceptance answer has gone back, and never throws: a payout
 * problem can not change or delay what happened to the buyer's payment.
 */
export async function payoutAfterCapture(deal: { dealId: string; amountUsd: number }, deps?: PushDeps): Promise<PayoutResult | null> {
  try {
    const r = await pushFunds({ dealId: deal.dealId, amountUsd: deal.amountUsd }, deps);
    await recordPayout(r);
    return r;
  } catch (e) {
    console.warn("[visa-direct] payout after capture failed:", (e as Error).message);
    return null;
  }
}
