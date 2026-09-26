import { MissingEnvError } from "@/server/env";
import { visaCreds } from "@/server/visa/creds";
import { allowedOrigin, captureContext, underLimit } from "@/server/visa/microform";

/** POST -> { captureContext } for Visa Microform card fields on this page's origin (PLAN 3.9). */
export async function POST(request: Request) {
  const origin = allowedOrigin(request.headers.get("origin") ?? new URL(request.url).origin);
  if (!origin) return Response.json({ error: "Card fields are only issued to this app's own pages." }, { status: 403 });
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!underLimit(ip)) return Response.json({ error: "Too many card-field requests; wait a minute." }, { status: 429, headers: { "retry-after": "60" } });
  let creds;
  try {
    creds = visaCreds();
  } catch (e) {
    if (e instanceof MissingEnvError) return Response.json({ error: "Visa sandbox keys are not configured on this deployment." }, { status: 503 });
    throw e;
  }
  const r = await captureContext(creds, origin);
  if (!r.ok) return Response.json({ error: `Visa did not issue card fields: ${r.reason}` }, { status: 502 });
  return Response.json({ captureContext: r.jwt, origin }, { headers: { "cache-control": "no-store" } });
}
