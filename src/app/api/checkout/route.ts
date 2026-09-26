import { MissingEnvError } from "@/server/env";
import { authorize, newDealId } from "@/server/visa/acceptance";
import { visaCreds, SANDBOX_TEST_CARD } from "@/server/visa/creds";
import { issueDealToken } from "@/server/deals/token";

/**
 * POST { listing, amountUsd } -> a real Visa Acceptance sandbox authorization with capture OFF: the HOLD.
 * Returns the deal token that /api/pickup needs to settle exactly this hold.
 */
export async function POST(request: Request) {
  const b = (await request.json().catch(() => null)) as { listing?: unknown; amountUsd?: unknown } | null;
  const listing = typeof b?.listing === "string" ? b.listing.trim().slice(0, 80) : "";
  const amountUsd = typeof b?.amountUsd === "number" ? Math.round(b.amountUsd * 100) / 100 : NaN;
  if (!listing || !(amountUsd >= 1 && amountUsd <= 2000)) {
    return Response.json({ error: "listing (text) and amountUsd (1 to 2000) are required" }, { status: 400 });
  }
  let creds;
  try {
    creds = visaCreds();
  } catch (e) {
    if (e instanceof MissingEnvError) return Response.json({ error: "Visa sandbox keys are not configured on this deployment." }, { status: 503 });
    throw e;
  }
  const dealId = newDealId();
  const auth = await authorize(creds, { dealId, amountUsd, source: { card: SANDBOX_TEST_CARD } });
  if (auth.status !== "AUTHORIZED" || !auth.id) {
    const unsure = !auth.parsed || auth.httpStatus === 0 || auth.httpStatus >= 500;
    const error = unsure
      ? "Visa did not confirm. A hold MAY have been placed; it will lapse on its own if nobody captures it. Do not retry right away."
      : `Visa did not authorize: ${auth.status} ${auth.reason ?? ""}`.trim();
    return Response.json({ error, visa: { status: auth.status, httpStatus: auth.httpStatus } }, { status: 502 });
  }
  return Response.json({
    dealId, listing, amountUsd, status: "HELD",
    visa: { authId: auth.id, status: auth.status, httpStatus: auth.httpStatus, host: creds.host },
    token: issueDealToken(creds.secret, { dealId, authId: auth.id, amountUsd }),
    at: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store" } });
}
