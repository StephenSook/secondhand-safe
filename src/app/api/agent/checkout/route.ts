import { MissingEnvError } from "@/server/env";
import { agentKey } from "@/server/tap/agent";
import { signRequest } from "@/server/tap/tap";

/**
 * Our shopping agent buying on the parent's behalf. It signs a checkout request with Trusted Agent Protocol
 * (RFC 9421, Ed25519) and sends it to the merchant endpoint /api/checkout on this same deployment.
 * POST { listing, amountUsd, tamper?: boolean }. With tamper, the amount is changed AFTER signing, the way a
 * man-in-the-middle would; the merchant must refuse it. Returns both sides so the demo shows the handshake.
 */
export async function POST(request: Request) {
  const b = (await request.json().catch(() => null)) as { listing?: string; amountUsd?: number; tamper?: boolean } | null;
  const listing = typeof b?.listing === "string" ? b.listing.slice(0, 80) : "Harppa high chair (table prop)";
  const amountUsd = typeof b?.amountUsd === "number" ? b.amountUsd : 64;
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
