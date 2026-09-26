import { MissingEnvError } from "@/server/env";
import { checkLabel } from "@/server/recalls/match";
import { visaCreds } from "@/server/visa/creds";
import { verifyDealToken } from "@/server/deals/token";
import { settle } from "@/server/deals/settle";
import type { ProductClass } from "@/core/verdict";

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
    model: str(b.model), batch: str(b.batch), upc: str(b.upc), text: str(b.text),
    cls: cls && CLASSES.includes(cls.cls as ProductClass) && typeof cls.p === "number" ? { cls: cls.cls as ProductClass, p: cls.p } : undefined,
  });
  const out = await settle(creds, deal, verdict);
  return Response.json({
    dealId: deal.dealId, amountUsd: deal.amountUsd, status: out.status, verdict,
    visa: out.visa ? { id: out.visa.id, status: out.visa.status, httpStatus: out.visa.httpStatus, reason: out.visa.reason, authId: deal.authId } : { authId: deal.authId },
    at: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store" } });
}
