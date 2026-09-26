import { getDb } from "@/server/db/mongo";
import { recallCallConfig, signTicket, verifyTicket } from "@/server/call/config";
import { buildNcco } from "@/server/call/ncco";
import { getCall } from "@/server/call/store";

const bye = () => Response.json([{ action: "talk", text: "Goodbye.", language: "en-US" }]);

/** POST (Vonage DTMF input webhook) ?c=<ticket>: "1" replays the verdict, at most MAX_REPLAYS times; anything else ends. */
export async function POST(request: Request) {
  const cfg = recallCallConfig();
  if (!cfg) return bye();
  const t = verifyTicket(cfg.secret, new URL(request.url).searchParams.get("c"), "input");
  if (!t) return new Response("forbidden", { status: 403 });
  const b = (await request.json().catch(() => null)) as { dtmf?: { digits?: unknown } } | null;
  if (b?.dtmf?.digits !== "1") return bye();
  const db = await getDb().catch(() => null);
  const call = db ? await getCall(db, t.k) : null;
  if (!call?.text) return bye();
  const n = (t.n ?? 0) + 1;
  const tk = (p: "audio" | "input", extra?: number) => encodeURIComponent(signTicket(cfg.secret, { k: t.k, p, ...(extra !== undefined ? { n: extra } : {}) }));
  const base = `${cfg.baseUrl}/api/recall-call`;
  return Response.json(buildNcco({ text: call.text, audioUrl: call.mode === "stream" ? `${base}/audio?c=${tk("audio")}` : null, inputUrl: `${base}/input?c=${tk("input", n)}`, replays: n }));
}
