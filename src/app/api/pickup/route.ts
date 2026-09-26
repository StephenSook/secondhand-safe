import { MissingEnvError } from "@/server/env";
import { checkLabel } from "@/server/recalls/match";
import { visaCreds } from "@/server/visa/creds";
import { verifyDealToken } from "@/server/deals/token";
import { settle } from "@/server/deals/settle";
import type { ProductClass } from "@/core/verdict";
import { anchor, passportMemo, recordHash } from "@/server/solana/memo";
import { recordSettlement } from "@/server/deals/store";
import { payoutAfterCapture } from "@/server/deals/payout";
import { waitUntil } from "@vercel/functions";

const CLASSES: ProductClass[] = ["inclined_or_inbed_sleeper", "crib_bumper", "drop_side_crib", "other"];

/**
 * POST { token, model?, batch?, upc?, text?, cls? } -> the pickup decision, executed on the real hold:
 * NO_MATCH captures, RECALL_MATCH / BANNED_TYPE reverses, anything uncertain keeps the hold.
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
  const recorded = recordSettlement(deal.dealId, { status: out.status,
    verdict: { kind: verdict.kind, reason: verdict.reason, recall: verdict.recall?.recallNumber ?? null },
    passportPath: passport && "path" in passport ? passport.path : null,
    label: { model: str(b.model) ?? null, batch: str(b.batch) ?? null, date: str(b.date) ?? null, upc: str(b.upc) ?? null } });
  // Visa Direct seller payout (PLAN 3.17), only after a confirmed capture, in the background: it never delays or
  // changes this response. It runs after the settlement write so the timeline reads CAPTURED, then the payout.
  waitUntil(out.status === "CAPTURED" ? recorded.then(() => payoutAfterCapture({ dealId: deal.dealId, amountUsd: deal.amountUsd })) : recorded);
  return Response.json({
    dealId: deal.dealId, amountUsd: deal.amountUsd, status: out.status, verdict, ...(passport ? { passport } : {}),
    visa: out.visa ? { id: out.visa.id, status: out.visa.status, httpStatus: out.visa.httpStatus, reason: out.visa.reason, authId: deal.authId } : { authId: deal.authId },
    at: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store" } });
}
