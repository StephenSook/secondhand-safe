import { MissingEnvError } from "@/server/env";
import { helloWorld, visaDirectCreds } from "@/server/visa/direct";

/**
 * Visa Direct connectivity probe: Visa's own GET /vdp/helloworld over two-way TLS with this deployment's VDP
 * credentials. Answers { configured, ok, httpStatus } only, never a credential. Cached for a minute per instance
 * so a busy page can not turn into a stream of calls to Visa.
 */
let cache: { at: number; body: { configured: true; mle: boolean; ok: boolean; httpStatus: number; error?: string; checkedAt: string } } | null = null;

export async function GET() {
  const headers = { "cache-control": "no-store" };
  let creds;
  try {
    creds = visaDirectCreds(process.env, "optional"); // helloworld needs only two-way TLS
  } catch (e) {
    if (e instanceof MissingEnvError) return Response.json({ configured: false, ok: false }, { status: 503, headers });
    throw e;
  }
  if (!cache || Date.now() - cache.at > 60_000) {
    const r = await helloWorld(creds);
    cache = { at: Date.now(), body: { configured: true, mle: creds.mle !== null, ...r, checkedAt: new Date().toISOString() } };
  }
  return Response.json(cache.body, { status: cache.body.ok ? 200 : 503, headers });
}
