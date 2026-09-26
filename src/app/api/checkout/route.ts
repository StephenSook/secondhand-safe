import { MissingEnvError } from "@/server/env";
import { authorize, newDealId } from "@/server/visa/acceptance";
import { visaCreds, SANDBOX_TEST_CARD } from "@/server/visa/creds";
import { issueDealToken } from "@/server/deals/token";
import { verifyAgentRequest } from "@/server/tap/agent";
import { isTransientToken } from "@/server/visa/microform";
import { recordHold } from "@/server/deals/store";
import { waitUntil } from "@vercel/functions";

/**
 * POST { listing, amountUsd, transientTokenJwt? } -> a real Visa Acceptance sandbox authorization with capture OFF: the HOLD.
 * With a Microform transient token the parent's own card entry is authorized (the card never reaches us);
 * without one, Visa's published sandbox test card is used and the response says so.
 * Returns the deal token that /api/pickup needs to settle exactly this hold.
 * A request carrying Trusted Agent Protocol headers (an AI agent buying for a parent) must verify first: a bad
 * signature, edited body, expired window, unknown key or replayed nonce is refused before Visa is called.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  let agent: { keyid: string } | undefined;
  if (request.headers.has("signature-input")) {
    let v;
    try {
      v = await verifyAgentRequest("POST", request.url, raw, request.headers);
    } catch (e) {
      if (e instanceof MissingEnvError) return Response.json({ error: "Agent requests are not accepted on this deployment (no TAP key)." }, { status: 503 });
      throw e;
    }
    if (!v.ok) return Response.json({ error: `Trusted Agent Protocol check failed: ${v.reason}. No payment was attempted.`, tap: v }, { status: 401 });
    agent = { keyid: v.keyid };
  }
  let b: { listing?: unknown; amountUsd?: unknown; transientTokenJwt?: unknown } | null = null;
  try { b = JSON.parse(raw); } catch {}
  const listing = typeof b?.listing === "string" ? b.listing.trim().slice(0, 80) : "";
  const amountUsd = typeof b?.amountUsd === "number" ? Math.round(b.amountUsd * 100) / 100 : NaN;
  if (!listing || !(amountUsd >= 1 && amountUsd <= 2000)) {
    return Response.json({ error: "listing (text) and amountUsd (1 to 2000) are required" }, { status: 400 });
  }
  if (b?.transientTokenJwt !== undefined && !isTransientToken(b.transientTokenJwt)) {
    return Response.json({ error: "transientTokenJwt is not a Microform token" }, { status: 400 });
  }
  const tt = isTransientToken(b?.transientTokenJwt) ? b.transientTokenJwt : undefined;
  let creds;
  try {
    creds = visaCreds();
  } catch (e) {
    if (e instanceof MissingEnvError) return Response.json({ error: "Visa sandbox keys are not configured on this deployment." }, { status: 503 });
    throw e;
  }
  const dealId = newDealId();
  const auth = await authorize(creds, { dealId, amountUsd, source: tt ? { transientTokenJwt: tt } : { card: SANDBOX_TEST_CARD } });
  if (auth.status !== "AUTHORIZED" || !auth.id) {
    // AUTHORIZED_PENDING_REVIEW (any AUTHORIZED*, or AUTHORIZED without an id) can mean a hold exists; a readable
    // DECLINED comes back as 201 too and means no hold, so 2xx alone is not "unsure".
    const unsure = !auth.parsed || auth.httpStatus === 0 || auth.httpStatus >= 500 || auth.status.startsWith("AUTHORIZED");
    const error = unsure
      ? "Visa did not confirm. A hold MAY have been placed; it will lapse on its own if nobody captures it. Do not retry right away."
      : `Visa did not authorize: ${auth.status} ${auth.reason ?? ""}`.trim();
    return Response.json({ error, visa: { status: auth.status, httpStatus: auth.httpStatus } }, { status: 502 });
  }
  waitUntil(recordHold({ dealId, listing, amountUsd, card: tt ? "microform" : "sandbox-test-card", agent: agent?.keyid ?? null }));
  return Response.json({
    dealId, listing, amountUsd, status: "HELD", card: tt ? "microform" : "sandbox-test-card", ...(agent ? { tap: { verified: true, keyid: agent.keyid } } : {}),
    visa: { authId: auth.id, status: auth.status, httpStatus: auth.httpStatus, host: creds.host },
    token: issueDealToken(creds.secret, { dealId, authId: auth.id, amountUsd }),
    at: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store" } });
}
