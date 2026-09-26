import { requireEnv, MissingEnvError } from "@/server/env";
import { readLabel } from "@/server/ml/label";
import { resolveGeminiKey } from "@/server/ml/gcpToken";

/** POST { imageDataUrl } -> readLabel() output (PLAN contract). 503 with a plain reason when not configured. */
export async function POST(request: Request) {
  let key: string;
  try {
    key = requireEnv(["GEMINI_API_KEY"]).GEMINI_API_KEY;
  } catch (e) {
    if (e instanceof MissingEnvError) {
      return Response.json({ error: "The label reader is not configured on this deployment (no Gemini key). Type the model number instead." }, { status: 503 });
    }
    throw e;
  }
  const body = (await request.json().catch(() => null)) as { imageDataUrl?: string } | null;
  const m = body?.imageDataUrl?.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return Response.json({ error: "imageDataUrl must be a base64 JPEG, PNG or WebP data URL" }, { status: 400 });
  if (m[2].length > 8_000_000) return Response.json({ error: "image too large (max ~6 MB)" }, { status: 413 });
  try {
    return Response.json(await readLabel(m[2], m[1], await resolveGeminiKey(key)), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: `The label reader failed: ${(e as Error).message}` }, { status: 502 });
  }
}
