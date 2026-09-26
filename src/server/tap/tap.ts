import { createHash, createPrivateKey, createPublicKey, sign, verify, randomBytes, type KeyObject } from "node:crypto";

/**
 * Trusted Agent Protocol request signing (PLAN 1.1 / 3.10), RFC 9421 HTTP Message Signatures with Ed25519.
 * Header shape follows Visa's reference verifier (github.com/visa/trusted-agent-protocol): Signature-Agent,
 * Signature-Input sig1=(...);nonce;created;expires;keyid;tag, Signature sig1=:b64:. We additionally cover
 * "@method" and "content-digest", so an edited amount breaks the signature, and set alg="ed25519".
 */
export const TAP_TAG = "agent-payer-auth";
export const TAP_WINDOW_S = 480;
const COMPONENTS = ['"@method"', '"@authority"', '"@path"', '"content-digest"'];

export interface SignedHeaders { "signature-input": string; signature: string; "content-digest": string; "signature-agent"?: string }

const PKCS8_ED25519 = "302e020100300506032b657004220420";

export function keyFromSeedHex(seedHex: string): { priv: KeyObject; pubRawB64u: string } {
  if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error("TAP private key must be 32 bytes of hex");
  const priv = createPrivateKey({ key: Buffer.from(PKCS8_ED25519 + seedHex, "hex"), format: "der", type: "pkcs8" });
  const jwk = createPublicKey(priv).export({ format: "jwk" }) as { x: string };
  return { priv, pubRawB64u: jwk.x };
}

export function publicKeyFromB64u(x: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
}

export const contentDigest = (body: string) => `sha-256=:${createHash("sha256").update(body, "utf8").digest("base64")}:`;

function params(created: number, keyid: string, nonce: string) {
  return `(${COMPONENTS.join(" ")});created=${created};expires=${created + TAP_WINDOW_S};keyid="${keyid}";alg="ed25519";nonce="${nonce}";tag="${TAP_TAG}"`;
}

/** RFC 9421 signature base: one line per covered component, then "@signature-params". */
function signatureBase(method: string, url: URL, digest: string, sigParams: string) {
  return [
    `"@method": ${method.toUpperCase()}`,
    `"@authority": ${url.host.toLowerCase()}`,
    `"@path": ${url.pathname}`,
    `"content-digest": ${digest}`,
    `"@signature-params": ${sigParams}`,
  ].join("\n");
}

export function signRequest(method: string, url: string, body: string, key: { id: string; seedHex: string; agentUrl?: string },
  now = Math.floor(Date.now() / 1000)): SignedHeaders {
  const u = new URL(url);
  const digest = contentDigest(body);
  const nonce = randomBytes(16).toString("base64url");
  const sigParams = params(now, key.id, nonce);
  const sig = sign(null, Buffer.from(signatureBase(method, u, digest, sigParams)), keyFromSeedHex(key.seedHex).priv);
  return {
    "signature-input": `sig1=${sigParams}`,
    signature: `sig1=:${sig.toString("base64")}:`,
    "content-digest": digest,
    ...(key.agentUrl ? { "signature-agent": `"${key.agentUrl}"` } : {}),
  };
}

export type VerifyResult = { ok: true; keyid: string; nonce: string } | { ok: false; reason: string };

// nonce capped to 8-64 url-safe chars so junk requests cannot store large values
const INPUT_RX = /^sig1=\(([^)]*)\);created=(\d+);expires=(\d+);keyid="([^"]{1,64})";alg="([^"]+)";nonce="([A-Za-z0-9_-]{8,64})";tag="([^"]+)"$/;

/** Order: components, alg/tag, digest, window, known key, SIGNATURE, then nonce. The nonce is recorded only for
 *  a request whose signature verified, so unauthenticated junk cannot fill the nonce store. */
export async function verifyRequest(method: string, url: string, body: string, h: Partial<SignedHeaders>,
  pubB64uById: (id: string) => string | undefined, seenNonce: (n: string) => Promise<boolean>,
  now = Math.floor(Date.now() / 1000)): Promise<VerifyResult> {
  const input = h["signature-input"]?.trim();
  const sigHeader = h.signature?.trim().match(/^sig1=:([A-Za-z0-9+/=]+):$/);
  const m = input?.match(INPUT_RX);
  if (!input || !m || !sigHeader) return { ok: false, reason: "malformed" };
  const [, comps, createdS, expiresS, keyid, alg, nonce, tag] = m;
  if (comps.trim() !== COMPONENTS.join(" ")) return { ok: false, reason: "components" };
  if (alg !== "ed25519" || tag !== TAP_TAG) return { ok: false, reason: "alg-or-tag" };
  const digest = contentDigest(body);
  if (h["content-digest"] !== digest) return { ok: false, reason: "digest" };
  const created = Number(createdS), expires = Number(expiresS);
  if (expires - created > TAP_WINDOW_S || created > now + 5 || now > expires) return { ok: false, reason: "expired" };
  const pub = pubB64uById(keyid);
  if (!pub) return { ok: false, reason: "unknown-key" };
  const base = signatureBase(method, new URL(url), digest, input.slice("sig1=".length));
  let good = false;
  try {
    good = verify(null, Buffer.from(base), publicKeyFromB64u(pub), Buffer.from(sigHeader[1], "base64"));
  } catch {
    good = false; // malformed key or signature bytes: a refusal, never a 500
  }
  if (!good) return { ok: false, reason: "signature" };
  if (await seenNonce(nonce)) return { ok: false, reason: "replay" };
  return { ok: true, keyid, nonce };
}
