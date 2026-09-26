import type { Verdict } from "@/core/verdict";
import { getDb } from "@/server/db/mongo";
import { recallCall, type CallDeps, type CallOutcome } from "./trigger";

/**
 * Called from /api/pickup inside waitUntil, only when Visa CONFIRMED the reversal. It first waits (briefly) for the
 * settlement to be on the deal record, so the call is placed after the settlement is recorded and its timeline entry
 * lands after the reversal's; if the record never shows up, the call still goes out, because Visa already answered.
 */
export async function callAfterReversal(dealId: string, verdict: Verdict, deps: CallDeps & { waitMs?: number } = {}): Promise<CallOutcome> {
  if (verdict.kind !== "RECALL_MATCH" && verdict.kind !== "BANNED_TYPE") return { state: "no-optin" };
  const db = deps.db !== undefined ? deps.db : await getDb().catch(() => null);
  const until = Date.now() + (deps.waitMs ?? 8000);
  while (db && Date.now() < until) {
    const d = await db.collection<{ _id: string; status: string }>("deals").findOne({ _id: dealId }, { projection: { status: 1 }, maxTimeMS: 2000 }).catch(() => null);
    if (d?.status === "REVERSED") break;
    await new Promise((ok) => setTimeout(ok, 700));
  }
  return recallCall(dealId, { kind: "reversed", verdict: verdict.kind, recallNumber: verdict.recall?.recallNumber ?? null }, { ...deps, db });
}
