import { requireEnv } from "@/server/env";
import { keyFromSeedHex, verifyRequest, type SignedHeaders, type VerifyResult } from "./tap";

/** Our shopping agent's signing key, and the directory the merchant side trusts (Web Bot Auth style). */
export function agentKey() {
  const e = requireEnv(["TAP_AGENT_PRIVATE_KEY_HEX", "TAP_AGENT_KEY_ID"]);
  return { id: e.TAP_AGENT_KEY_ID, seedHex: e.TAP_AGENT_PRIVATE_KEY_HEX, pub: keyFromSeedHex(e.TAP_AGENT_PRIVATE_KEY_HEX).pubRawB64u };
}

/**
 * Nonces seen by this server instance within the 480 s window. Serverless instances do not share memory, so
 * replay protection is per instance until the nonce store moves to Atlas (PLAN 3.11); the window still caps it.
 */
const seen = new Map<string, number>();
async function seenNonce(n: string) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 600_000) seen.delete(k);
  if (seen.has(n)) return true;
  seen.set(n, now);
  return false;
}

export async function verifyAgentRequest(method: string, url: string, body: string, headers: Headers): Promise<VerifyResult> {
  const k = agentKey();
  const h: Partial<SignedHeaders> = {
    "signature-input": headers.get("signature-input") ?? undefined,
    signature: headers.get("signature") ?? undefined,
    "content-digest": headers.get("content-digest") ?? undefined,
  };
  return verifyRequest(method, url, body, h, (id) => (id === k.id ? k.pub : undefined), seenNonce);
}
