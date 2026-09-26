import { requireEnv, MissingEnvError } from "@/server/env";
import { mintSignedUrl, sameSiteRequest } from "@/server/voice/agent";
import { getDb } from "@/server/db/mongo";
import { underLimit } from "@/server/visa/microform";

const NO_STORE = { "cache-control": "no-store" };
/** Voice sessions per UTC day across every instance (each call is also capped at 180 s by the agent config). */
// "0" turns voice off; an empty or mistyped setting falls back to 60 instead of silently blocking every session
const capRaw = process.env.VOICE_DAILY_CAP?.trim();
const capNum = Number(capRaw);
const DAILY_CAP = capRaw === "0" ? 0 : Number.isFinite(capNum) && capNum > 0 ? capNum : 60;

/** Counts today's sessions in Atlas. true = under the cap; null = Atlas unavailable (the per-IP limit still holds). */
async function underDailyCap(): Promise<boolean | null> {
  const db = await getDb().catch(() => null);
  if (!db) return null;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const doc = await db.collection<{ _id: string; n: number }>("counters").findOneAndUpdate(
      { _id: `voice-sessions:${day}` }, { $inc: { n: 1 } }, { upsert: true, returnDocument: "after", maxTimeMS: 3_000 });
    return (doc?.n ?? 0) <= DAILY_CAP;
  } catch {
    return null;
  }
}

/**
 * GET -> { signedUrl } for the Lullabuy ElevenLabs agent (PLAN 5.6). The API key stays on the server; the browser
 * opens the conversation with a signed URL that expires in about 15 minutes. Only our own pages may ask, each IP
 * gets 10 a minute, and the whole site gets DAILY_CAP a day, so nobody can quietly drain the plan's minutes.
 */
export async function GET(request: Request) {
  if (!sameSiteRequest(request)) {
    return Response.json({ error: "Voice sessions start from the Lullabuy shop page." }, { status: 403, headers: NO_STORE });
  }
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!underLimit(`voice-session:${ip}`, 10)) {
    return Response.json({ error: "Too many voice sessions; wait a minute." }, { status: 429, headers: NO_STORE });
  }
  let env: Record<"ELEVENLABS_API_KEY" | "ELEVENLABS_AGENT_ID", string>;
  try {
    env = requireEnv(["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID"]);
  } catch (e) {
    if (e instanceof MissingEnvError) {
      return Response.json({ error: "The voice agent is not configured on this deployment." }, { status: 503, headers: NO_STORE });
    }
    throw e;
  }
  if (DAILY_CAP === 0) {
    return Response.json({ error: "The voice agent is switched off right now. Type your request instead." }, { status: 503, headers: NO_STORE });
  }
  // fail closed: without a readable daily count there is no global budget, so no session is minted
  const under = await underDailyCap();
  if (under === null) {
    return Response.json({ error: "The voice agent cannot check today's budget right now. Type your request instead." }, { status: 503, headers: NO_STORE });
  }
  if (!under) {
    return Response.json({ error: "The voice agent has used today's minutes. Type your request instead." }, { status: 429, headers: NO_STORE });
  }
  try {
    const signedUrl = await mintSignedUrl(env.ELEVENLABS_AGENT_ID, env.ELEVENLABS_API_KEY);
    return Response.json({ signedUrl }, { headers: NO_STORE });
  } catch (e) {
    console.warn("[voice-agent] signed URL failed:", (e as Error).message);
    return Response.json({ error: "Could not start a voice session right now." }, { status: 502, headers: NO_STORE });
  }
}
