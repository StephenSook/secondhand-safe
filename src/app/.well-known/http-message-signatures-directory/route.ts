import { MissingEnvError } from "@/server/env";
import { agentKey } from "@/server/tap/agent";

/** Public key directory for our Trusted Agent Protocol agent (Web Bot Auth key directory, JWKS). */
export async function GET() {
  try {
    const k = agentKey();
    return Response.json({ keys: [{ kty: "OKP", crv: "Ed25519", x: k.pub, kid: k.id, use: "sig", alg: "EdDSA" }] },
      { headers: { "content-type": "application/http-message-signatures-directory+json", "cache-control": "public, max-age=300" } });
  } catch (e) {
    if (e instanceof MissingEnvError) return Response.json({ keys: [] }, { status: 503 });
    throw e;
  }
}
