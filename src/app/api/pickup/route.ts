import { MissingEnvError } from "@/server/env";
import { checkLabel } from "@/server/recalls/match";
import { visaCreds } from "@/server/visa/creds";
import { verifyDealToken } from "@/server/deals/token";
import { decide, settle } from "@/server/deals/settle";
import { mongoClaims, settleOnce } from "@/server/deals/claim";
import type { ProductClass } from "@/core/verdict";
import { anchor, passportMemo, recordHash } from "@/server/solana/memo";
import { getDeal, recordSettlement } from "@/server/deals/store";
import { waitUntil } from "@vercel/functions";

const CLASSES: ProductClass[] = ["inclined_or_inbed_sleeper", "crib_bumper", "drop_side_crib", "other"];
const FINAL = new Set(["CAPTURED", "REVERSED", "RELEASED", "LAPSED", "REFUSED"]);

/** The deal record's status when it is already final (settled before claims existed, or by the sweeper). */
async function finalStatus(dealId: string): Promise<string | null> {
  const r = await getDeal(dealId);
  if (r.state === "unavailable") throw new Error("the deal record could not be read");
  return r.state === "ok" && FINAL.has(r.deal.status) ? r.deal.status : null;
}

/**
 * POST { token, model?, batch?, upc?, text?, cls? } -> the pickup decision, executed on the real hold:
 * NO_MATCH captures, RECALL_MATCH / BANNED_TYPE reverses, anything uncertain keeps the hold.
 * Once a deal has settled, every later request returns that stored answer with `replayed: true` (no Visa call).
 * 409 `{settling: true, visaCalled: false}`: another request is settling this deal right now; this one did nothing.
 * 409 `{uncertain: true, status: "UNKNOWN", visaCalled: false}`: an earlier attempt never stored its result.
 * 409 `{final: true, status, visaCalled: false}`: the deal record already shows this deal ended; nothing was sent.
 * 503 `{visaCalled: false, placed: false}`: the deal's state could not be read, so Visa was not called.
 * A scan that moves no money returns its verdict with status UNKNOWN (`holdStateUnconfirmed`) when the deal's
 * state could not be read, never HELD.
 */
export async function POST(request: Request) {
  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b.token !== "string") return Response.json({ error: "token required" }, { status: 400 });
  let creds;
  try {
    creds = visaCreds();
  } catch (e) {
    if (e instanceof MissingEnvError) return Response.json({ error: "Visa sandbox keys are not configured on this deployment." }, { status: 503 });
    throw e;
  }
  const deal = verifyDealToken(creds.secret, b.token);
  if (!deal) return Response.json({ error: "This deal token is invalid or expired." }, { status: 403 });
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : undefined);
  const cls = b.cls as { cls?: string; p?: number } | undefined;
  const verdict = checkLabel({
    model: str(b.model), batch: str(b.batch), date: str(b.date), upc: str(b.upc), text: str(b.text),
    cls: cls && CLASSES.includes(cls.cls as ProductClass) && typeof cls.p === "number" ? { cls: cls.cls as ProductClass, p: cls.p } : undefined,
  });
  const noStore = { "cache-control": "no-store" };
  // One settlement per deal (src/server/deals/claim.ts): exactly one request calls Visa; a concurrent or repeated
  // request gets that request's stored answer. A scan that moves no money never takes the claim.
  const outcome = await settleOnce(deal.dealId, async () => {
    const out = await settle(creds, deal, verdict);
    // Item passport: only for a completed sale. The record holds no personal data; only its hash goes on chain.
    let passport: { signature: string; path: string } | { error: string } | undefined;
    const sol = process.env.SOLANA_SECRET_KEY_B58?.trim();
    if (out.status === "CAPTURED" && sol) {
      const record = JSON.stringify({
        v: 1, dealId: deal.dealId, amountUsd: deal.amountUsd, verdict: verdict.kind, reason: verdict.reason, indexAsOf: verdict.asOf,
        label: { model: str(b.model) ?? null, batch: str(b.batch) ?? null, date: str(b.date) ?? null, upc: str(b.upc) ?? null },
        visaCapture: out.visa?.id ?? null, at: new Date().toISOString(),
      });
      try {
        const signature = await anchor(sol, passportMemo(deal.dealId, recordHash(record)));
        passport = { signature, path: `/passport/${signature}?r=${Buffer.from(record).toString("base64url")}` };
      } catch (e) {
        passport = { error: `Passport not written: ${(e as Error).message}` };
      }
    }
    waitUntil(recordSettlement(deal.dealId, { status: out.status,
      verdict: { kind: verdict.kind, reason: verdict.reason, recall: verdict.recall?.recallNumber ?? null },
      passportPath: passport && "path" in passport ? passport.path : null,
      label: { model: str(b.model) ?? null, batch: str(b.batch) ?? null, date: str(b.date) ?? null, upc: str(b.upc) ?? null } }));
    return {
      dealId: deal.dealId, amountUsd: deal.amountUsd, status: out.status, verdict, ...(passport ? { passport } : {}),
      visa: out.visa ? { id: out.visa.id, status: out.visa.status, httpStatus: out.visa.httpStatus, reason: out.visa.reason, authId: deal.authId } : { authId: deal.authId },
      at: new Date().toISOString(),
    };
  }, { store: await mongoClaims(), claim: decide(verdict) !== "hold", finalStatus: () => finalStatus(deal.dealId) });
  if (outcome.kind === "unavailable" && decide(verdict) === "hold") {
    return Response.json({ dealId: deal.dealId, amountUsd: deal.amountUsd, status: "UNKNOWN", verdict, holdStateUnconfirmed: true, visaCalled: false,
      error: "The check ran, but the hold's state could not be confirmed (the deal store did not answer). No money moved from this scan." },
      { headers: noStore });
  }
  if (outcome.kind === "final") {
    return Response.json({ dealId: deal.dealId, status: outcome.status, final: true, visaCalled: false,
      error: `This deal already ended (${outcome.status}), so nothing was sent to Visa.` },
      { status: 409, headers: noStore });
  }
  if (outcome.kind === "unavailable") {
    return Response.json({ dealId: deal.dealId, visaCalled: false, placed: false,
      error: "Could not start the settlement (the deal store did not answer). Nothing moved at Visa; try again in a moment." },
      { status: 503, headers: noStore });
  }
  if (outcome.kind === "uncertain") {
    return Response.json({ dealId: deal.dealId, status: "UNKNOWN", uncertain: true, visaCalled: false,
      error: "The result of an earlier settlement attempt for this deal is not confirmed, so nothing was sent to Visa. Check the deal page or the Visa Business Center." },
      { status: 409, headers: noStore });
  }
  if (outcome.kind === "busy") {
    return Response.json({ dealId: deal.dealId, settling: true, visaCalled: false,
      error: "This hold is already being settled by another scan. This request did not reach Visa; the result shows on the deal in a moment." },
      { status: 409, headers: noStore });
  }
  // a replay is the stored answer of the request that did call Visa (its verdict, not this scan's)
  return Response.json(outcome.kind === "replayed" ? { ...outcome.result, replayed: true } : outcome.result, { headers: noStore });
}
