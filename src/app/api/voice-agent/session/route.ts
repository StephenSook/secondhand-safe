import { requireEnv, MissingEnvError } from "@/server/env";
import { mintSignedUrl } from "@/server/voice/agent";
import { underLimit } from "@/server/visa/microform";

const NO_STORE = { "cache-control": "no-store" };

/**
 * GET -> { signedUrl } for the Lullabuy ElevenLabs agent (PLAN 5.6). The API key stays on the server; the browser
 * opens the conversation with a signed URL that expires in about 15 minutes.
 */
export async function GET(request: Request) {
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
  try {
    const signedUrl = await mintSignedUrl(env.ELEVENLABS_AGENT_ID, env.ELEVENLABS_API_KEY);
    return Response.json({ signedUrl }, { headers: NO_STORE });
  } catch (e) {
    console.warn("[voice-agent] signed URL failed:", (e as Error).message);
    return Response.json({ error: "Could not start a voice session right now." }, { status: 502, headers: NO_STORE });
  }
}
