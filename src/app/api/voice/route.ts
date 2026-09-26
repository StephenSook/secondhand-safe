import { requireEnv, MissingEnvError } from "@/server/env";
import { speak, type Lang } from "@/server/voice/elevenlabs";
import type { VerdictKind } from "@/core/verdict";

const KINDS: VerdictKind[] = ["RECALL_MATCH", "BANNED_TYPE", "NO_MATCH", "NEEDS_CHECK", "UNREADABLE"];

/**
 * GET /api/voice?kind=RECALL_MATCH&lang=es -> audio/mpeg. The text is a fixed line per verdict (never free
 * text from the caller), so the endpoint cannot be used to speak arbitrary words. Cached per kind + language.
 */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const kind = q.get("kind") as VerdictKind;
  const lang = (q.get("lang") === "es" ? "es" : "en") as Lang;
  if (!KINDS.includes(kind)) return Response.json({ error: `kind must be one of ${KINDS.join(", ")}` }, { status: 400 });
  let key: string;
  try {
    key = requireEnv(["ELEVENLABS_API_KEY"]).ELEVENLABS_API_KEY;
  } catch (e) {
    if (e instanceof MissingEnvError) return Response.json({ error: "Voice is not configured on this deployment." }, { status: 503 });
    throw e;
  }
  try {
    const audio = await speak(kind, lang, key);
    return new Response(audio, {
      headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400, s-maxage=604800, immutable" },
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
