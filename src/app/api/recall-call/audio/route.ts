import { getDb } from "@/server/db/mongo";
import { recallCallConfig, verifyTicket } from "@/server/call/config";
import { getCall } from "@/server/call/store";

/** GET ?c=<ticket>: the ElevenLabs MP3 made for one call, fetched by Vonage's stream action. Tickets expire in 30 min. */
export async function GET(request: Request) {
  const cfg = recallCallConfig();
  if (!cfg) return new Response("not configured", { status: 503 });
  const t = verifyTicket(cfg.secret, new URL(request.url).searchParams.get("c"), "audio");
  if (!t) return new Response("forbidden", { status: 403 });
  const db = await getDb().catch(() => null);
  const call = db ? await getCall(db, t.k, true) : null;
  const a = call?.audio as unknown;
  const bytes = a instanceof Uint8Array ? a : (a as { buffer?: Uint8Array } | null)?.buffer;
  if (!bytes || !bytes.byteLength) return new Response("no audio", { status: 404 });
  return new Response(Buffer.from(bytes), { headers: { "content-type": "audio/mpeg", "cache-control": "private, no-store" } });
}
