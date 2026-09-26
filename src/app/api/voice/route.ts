import { requireEnv, MissingEnvError } from "@/server/env";
import { speak, speakText, summaryLine, type Lang } from "@/server/voice/elevenlabs";
import type { VerdictKind } from "@/core/verdict";

const KINDS: VerdictKind[] = ["RECALL_MATCH", "BANNED_TYPE", "NO_MATCH", "NEEDS_CHECK", "UNREADABLE"];

/**
 * GET /api/voice?kind=RECALL_MATCH&lang=es -> audio/mpeg. GET /api/voice?summary=10,0,2,8 speaks the shopping
 * agent's summary (total, blocked, need a check, passed), built from those four numbers only. The text is a fixed line per verdict (never free
 * text from the caller), so the endpoint cannot be used to speak arbitrary words. Cached per kind + language.
 */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const kind = q.get("kind") as VerdictKind;
  const lang = (q.get("lang") === "es" ? "es" : "en") as Lang;
  const sum = q.get("summary");
  const counts = sum?.split(",").map((x) => Number(x));
  const summaryOk = !!counts && counts.length === 4 && counts.every((n) => Number.isInteger(n) && n >= 0 && n <= 50)
    && counts[1] + counts[2] + counts[3] === counts[0];
  if (sum !== null && !summaryOk) return Response.json({ error: "summary must be total,blocked,check,passed (integers that add up, at most 50)" }, { status: 400 });
  if (sum === null && !KINDS.includes(kind)) return Response.json({ error: `kind must be one of ${KINDS.join(", ")}` }, { status: 400 });
  let key: string;
  try {
    key = requireEnv(["ELEVENLABS_API_KEY"]).ELEVENLABS_API_KEY;
  } catch (e) {
    if (e instanceof MissingEnvError) return Response.json({ error: "Voice is not configured on this deployment." }, { status: 503 });
    throw e;
  }
  try {
    const audio = summaryOk ? await speakText(summaryLine(counts![0], counts![1], counts![2], counts![3], lang), lang, key) : await speak(kind, lang, key);
    return new Response(audio, {
      headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400, s-maxage=604800, immutable" },
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
