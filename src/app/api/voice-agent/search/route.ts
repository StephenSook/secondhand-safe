import { shop } from "@/server/shop/agent";
import { shopGeminiKey } from "@/server/shop/key";
import { secretMatches, speakable } from "@/server/voice/agent";
import { underLimit } from "@/server/visa/microform";

const NO_STORE = { "cache-control": "no-store" };

/**
 * POST { q } -> the top 3 of the same pre-screened search /api/shop runs, in a compact shape the voice agent can
 * read aloud. This is the ElevenLabs webhook tool "search_lullabuy": ElevenLabs calls it from its own servers, not
 * from a browser, so it is authenticated by the shared secret header x-lullabuy-agent (ELEVENLABS_TOOL_SECRET).
 */
export async function POST(request: Request) {
  const expected = process.env.ELEVENLABS_TOOL_SECRET?.trim();
  if (!expected) {
    return Response.json({ error: "The voice agent's search tool is not configured on this deployment." }, { status: 503, headers: NO_STORE });
  }
  if (!secretMatches(request.headers.get("x-lullabuy-agent"), expected)) {
    return Response.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
  }
  // Every conversation's tool calls arrive from ElevenLabs' few server IPs, so the limit is generous and applies
  // only after the secret matched (an unauthenticated caller cannot use up the agent's budget).
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!underLimit(`voice-search:${ip}`, 240)) return Response.json({ error: "Too many searches; wait a minute." }, { status: 429, headers: NO_STORE });
  const b = (await request.json().catch(() => null)) as { q?: unknown } | null;
  const q = typeof b?.q === "string" ? b.q.trim().slice(0, 400) : "";
  if (q.length < 2) return Response.json({ error: "Ask the parent what they are looking for." }, { status: 400, headers: NO_STORE });
  const r = await shop(q, await shopGeminiKey());
  return Response.json(speakable(q, r), { headers: NO_STORE });
}
