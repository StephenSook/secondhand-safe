import { getVercelOidcToken } from "@vercel/functions/oidc";

/**
 * Keyless Vertex AI access from Vercel (no secret stored anywhere). GEMINI_API_KEY holds a non-secret config
 * string, "wif:<gcpProject>:<projectNumber>:<pool>:<provider>:<serviceAccountEmail>". The function's Vercel OIDC
 * token is exchanged at Google STS (Workload Identity Federation, provider restricted to this project's
 * production environment), then for a short-lived access token of a service account that holds only
 * roles/aiplatform.user. The result is the "vertex:<project>:<token>" form readLabel() already accepts.
 */
export interface WifConfig { project: string; projectNumber: string; pool: string; provider: string; serviceAccount: string }

export function parseWif(v: string): WifConfig | null {
  const p = v.split(":");
  if (p[0] !== "wif" || p.length !== 6 || p.slice(1).some((x) => !x)) return null;
  return { project: p[1], projectNumber: p[2], pool: p[3], provider: p[4], serviceAccount: p[5] };
}

let cached: { key: string; exp: number } | null = null;

export async function wifGeminiKey(cfg: WifConfig, f: typeof fetch = fetch, oidc: () => Promise<string> = getVercelOidcToken,
  now = Date.now()): Promise<string> {
  if (cached && cached.exp - 60_000 > now) return cached.key;
  const subject = await oidc();
  const sts = await f("https://sts.googleapis.com/v1/token", {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: `//iam.googleapis.com/projects/${cfg.projectNumber}/locations/global/workloadIdentityPools/${cfg.pool}/providers/${cfg.provider}`,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      subjectToken: subject,
    }),
  });
  const s = (await sts.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!sts.ok || !s.access_token) throw new Error(`Google STS refused the Vercel identity: ${s.error_description ?? sts.status}`);
  const gen = await f(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(cfg.serviceAccount)}:generateAccessToken`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.access_token}` }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ scope: ["https://www.googleapis.com/auth/cloud-platform"], lifetime: "3600s" }),
  });
  const g = (await gen.json().catch(() => ({}))) as { accessToken?: string; expireTime?: string; error?: { message?: string } };
  if (!gen.ok || !g.accessToken) throw new Error(`Service account token refused: ${g.error?.message ?? gen.status}`);
  const exp = g.expireTime ? Date.parse(g.expireTime) : now + 3_000_000;
  cached = { key: `vertex:${cfg.project}:${g.accessToken}`, exp };
  return cached.key;
}

/** GEMINI_API_KEY as configured -> a key readLabel() accepts (AI Studio key, vertex:..., or resolved wif:...). */
export async function resolveGeminiKey(raw: string): Promise<string> {
  const w = parseWif(raw);
  return w ? wifGeminiKey(w) : raw;
}

export const _resetWifCache = () => { cached = null; };
