import { MissingEnvError } from "@/server/env";
import { authorize, newDealId, reverse } from "@/server/visa/acceptance";
import { visaCreds, SANDBOX_TEST_CARD } from "@/server/visa/creds";
import { issueDealToken } from "@/server/deals/token";
import { verifyAgentRequest } from "@/server/tap/agent";
import { isTransientToken, underLimit } from "@/server/visa/microform";
import { issueSavedCard, verifySavedCard } from "@/server/visa/savedCard";
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
  // Unsigned (person) checkouts are limited per IP. Signed agent checkouts come from our own /api/agent/checkout,
  // which limits each client first, so they are not bucketed here by the server's shared egress IP.
  if (!request.headers.has("signature-input")) {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    if (!underLimit(`checkout:${ip}`, 20)) return Response.json({ error: "Too many checkouts from this address; wait a minute. No payment was attempted." }, { status: 429 });
  }
  if (request.headers.has("signature-input")) {
    let v;
    try {
      v = await verifyAgentRequest("POST", request.url, raw, request.headers);
    } catch (e) {
      if (e instanceof MissingEnvError) return Response.json({ placed: false, error: "Agent requests are not accepted on this deployment (no TAP key)." }, { status: 503 });
      throw e;
    }
    if (!v.ok) return Response.json({ placed: false, error: `Trusted Agent Protocol check failed: ${v.reason}. No payment was attempted.`, tap: v }, { status: 401 });
    agent = { keyid: v.keyid };
  }
  let b: { listing?: unknown; amountUsd?: unknown; transientTokenJwt?: unknown; saveCard?: unknown; savedCard?: unknown } | null = null;
  try { b = JSON.parse(raw); } catch {}
  const listing = typeof b?.listing === "string" ? b.listing.trim().slice(0, 80) : "";
  const amountUsd = typeof b?.amountUsd === "number" ? Math.round(b.amountUsd * 100) / 100 : NaN;
  if (!listing || !(amountUsd >= 1 && amountUsd <= 2000)) {
    return Response.json({ placed: false, error: "listing (text) and amountUsd (1 to 2000) are required" }, { status: 400 });
  }
  if (b?.transientTokenJwt !== undefined && !isTransientToken(b.transientTokenJwt)) {
    return Response.json({ placed: false, error: "transientTokenJwt is not a Microform token" }, { status: 400 });
  }
  const tt = isTransientToken(b?.transientTokenJwt) ? b.transientTokenJwt : undefined;
  let creds;
  try {
    creds = visaCreds();
  } catch (e) {
    if (e instanceof MissingEnvError) return Response.json({ placed: false, error: "Visa sandbox keys are not configured on this deployment." }, { status: 503 });
    throw e;
  }
  // a saved card (Visa Token Management Service) is only honored with our signature on it
  const saved = b?.savedCard !== undefined ? verifySavedCard(creds.secret, b.savedCard) : null;
  if (b?.savedCard !== undefined && !saved) return Response.json({ placed: false, error: "That saved card is not valid here; enter the card again." }, { status: 400 });
  const saveCard = b?.saveCard === true && !!tt && !saved;
  const source = saved ? { customerId: saved.customerId } : tt ? { transientTokenJwt: tt } : { card: SANDBOX_TEST_CARD };
  const cardKind = saved ? "saved-card" : tt ? "microform" : "sandbox-test-card";
  const dealId = newDealId();
  const auth = await authorize(creds, { dealId, amountUsd, source, saveCard });
  if (auth.status !== "AUTHORIZED" || !auth.id) {
    // AUTHORIZED_PENDING_REVIEW (any AUTHORIZED*, or AUTHORIZED without an id) can mean a hold exists; a readable
    // DECLINED comes back as 201 too and means no hold, so 2xx alone is not "unsure".
    const unsure = !auth.parsed || auth.httpStatus === 0 || auth.httpStatus >= 500 || auth.status.startsWith("AUTHORIZED");
    const error = unsure
      ? "Visa did not confirm. A hold MAY have been placed; it will lapse on its own if nobody captures it. Do not retry right away."
      : `Visa did not authorize: ${auth.status} ${auth.reason ?? ""}`.trim();
    // `uncertain` tells the client a hold may exist, so it must not offer a second hold for this purchase
    return Response.json({ error, uncertain: unsure, ...(unsure ? {} : { placed: false }), visa: { status: auth.status, httpStatus: auth.httpStatus } }, { status: 502 });
  }
  // the hold is what Visa authorized: less than asked when a card-linked promotion applied. More than asked is
  // never accepted: release it and refuse, rather than hold an amount the buyer did not agree to.
  if (auth.authorizedUsd && auth.authorizedUsd > amountUsd + 0.004) {
    const rel = await reverse(creds, auth.id, { dealId, amountUsd: auth.authorizedUsd, reason: "authorized more than the agreed price" });
    console.warn(`[checkout] Visa authorized ${auth.authorizedUsd} for an agreed ${amountUsd}; reversal ${rel.status}`);
    // claim a release only when Visa confirmed it; otherwise a hold MAY remain and the client must not allow another
    return Response.json(rel.ok
      ? { placed: false, error: "Visa authorized more than the agreed price; the hold was released. Nothing was charged." }
      : { uncertain: true, error: `Visa authorized more than the agreed price and did not confirm the release (${rel.status}). A hold MAY remain; it lapses on its own if nobody captures it.` },
      { status: 502 });
  }
  const heldUsd = auth.authorizedUsd && auth.authorizedUsd > 0 ? Math.round(auth.authorizedUsd * 100) / 100 : amountUsd;
  waitUntil(recordHold({ dealId, listing, amountUsd: heldUsd, card: cardKind, agent: agent?.keyid ?? null, authId: auth.id }));
  const customerId = (auth.raw as { tokenInformation?: { customer?: { id?: string } } })?.tokenInformation?.customer?.id;
  const newSaved = saveCard && customerId ? issueSavedCard(creds.secret, { customerId, masked: maskedFrom(tt!) }) : undefined;
  return Response.json({
    dealId, listing, amountUsd: heldUsd, ...(heldUsd !== amountUsd ? { askedUsd: amountUsd } : {}), ...(auth.promotion ? { promotion: auth.promotion } : {}),
    status: "HELD", card: cardKind, ...(newSaved ? { savedCard: newSaved, savedMasked: maskedFrom(tt!) } : {}),
    ...(saved ? { savedMasked: saved.masked } : {}), ...(agent ? { tap: { verified: true, keyid: agent.keyid } } : {}),
    visa: { authId: auth.id, status: auth.status, httpStatus: auth.httpStatus, host: creds.host },
    token: issueDealToken(creds.secret, { dealId, authId: auth.id, amountUsd: heldUsd }),
    at: new Date().toISOString(),
  }, { headers: { "cache-control": "no-store" } });
}

/** The masked card number Microform puts in its transient token (display only; the token is Visa-signed). */
function maskedFrom(jwt: string): string {
  try {
    const p = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()) as { content?: { paymentInformation?: { card?: { number?: { maskedValue?: string } } } } };
    const m = p.content?.paymentInformation?.card?.number?.maskedValue ?? "";
    return /^[X0-9]{12,19}$/i.test(m) ? m : "card";
  } catch {
    return "card";
  }
}
