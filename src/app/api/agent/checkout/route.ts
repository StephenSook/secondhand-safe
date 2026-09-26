import { MissingEnvError } from "@/server/env";
import { agentKey } from "@/server/tap/agent";
import { signRequest } from "@/server/tap/tap";
import { byId, prescreen } from "@/server/shop/catalog";
import { underLimit } from "@/server/visa/microform";

/**
 * Our shopping agent buying on the parent's behalf. It signs a checkout request with Trusted Agent Protocol
 * (RFC 9421, Ed25519) and sends it to the merchant endpoint /api/checkout on this same deployment.
 * POST { listingId } for a catalog listing (title and price come from the catalog, and a listing the pre-screen
 * marks red is refused before anything is signed), or { listing, amountUsd } for the items on our demo table.
 * tamper?: boolean. With tamper, the amount is changed AFTER signing, the way a
 * man-in-the-middle would; the merchant must refuse it. Returns both sides so the demo shows the handshake.
 * What "verified" means: the request came from OUR registered agent key and was not altered in transit. It is
 * not proof that a parent approved the amount (in Visa's model that is Intelligent Commerce mandates, which are
 * gated). Agent purchases are capped at AGENT_MAX_USD for that reason.
 */
const AGENT_MAX_USD = 200;
export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!underLimit(`agent:${ip}`, 20)) return Response.json({ error: "Too many agent checkouts; wait a minute." }, { status: 429 });
  const b = (await request.json().catch(() => null)) as { listingId?: string; listing?: string; amountUsd?: number; tamper?: boolean } | null;
  let listing = typeof b?.listing === "string" ? b.listing.slice(0, 80) : "Harppa high chair (table prop)";
  let amountUsd = typeof b?.amountUsd === "number" ? b.amountUsd : 64;
  if (typeof b?.listingId === "string") {
    const l = byId.get(b.listingId);
    if (!l) return Response.json({ error: "Unknown listing." }, { status: 404 });
    const screen = prescreen(l);
    if (screen.tone === "red") return Response.json({ error: `The agent will not buy this: ${screen.headline}. ${screen.reason}`, screen }, { status: 403 });
    listing = l.title.slice(0, 80);
    amountUsd = l.priceUsd ?? 0;
  }
  if (!(amountUsd >= 1 && amountUsd <= AGENT_MAX_USD)) {
    return Response.json({ error: `Agent purchases are limited to $1 to $${AGENT_MAX_USD}.` }, { status: 400 });
  }
  let key;
  try {
    key = agentKey();
  } catch (e) {
    if (e instanceof MissingEnvError) return Response.json({ error: "The agent's TAP signing key is not configured on this deployment." }, { status: 503 });
    throw e;
  }
  const origin = new URL(request.url).origin;
  const url = `${origin}/api/checkout`;
  const signedBody = JSON.stringify({ listing, amountUsd });
  const headers = signRequest("POST", url, signedBody, { id: key.id, seedHex: key.seedHex, agentUrl: `${origin}/.well-known/http-message-signatures-directory` });
  const sentBody = b?.tamper ? JSON.stringify({ listing, amountUsd: Math.round(amountUsd * 10) / 100 }) : signedBody;
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: sentBody });
  const merchant = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return Response.json({
    agent: { keyid: key.id, signed: JSON.parse(signedBody), sent: JSON.parse(sentBody), tampered: !!b?.tamper,
      "signature-input": headers["signature-input"], "content-digest": headers["content-digest"] },
    merchant: { httpStatus: res.status, ...merchant },
  }, { status: 200, headers: { "cache-control": "no-store" } });
}
