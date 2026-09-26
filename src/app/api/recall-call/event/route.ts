import { getDb } from "@/server/db/mongo";
import { recallCallConfig, verifyTicket } from "@/server/call/config";
import { updateCall, type CallStatus } from "@/server/call/store";

const MAP: Record<string, CallStatus> = { answered: "answered", completed: "completed", busy: "unanswered", cancelled: "unanswered", failed: "unanswered", rejected: "unanswered", timeout: "unanswered", unanswered: "unanswered" };

/** POST (Vonage call events) ?c=<ticket>: records answered / completed / unanswered on the call. Always 200. */
export async function POST(request: Request) {
  const cfg = recallCallConfig();
  const t = cfg ? verifyTicket(cfg.secret, new URL(request.url).searchParams.get("c"), "event") : null;
  if (t) {
    const b = (await request.json().catch(() => null)) as { status?: unknown } | null;
    const next = typeof b?.status === "string" ? MAP[b.status] : undefined;
    const db = next ? await getDb().catch(() => null) : null;
    // "completed" and "unanswered" are final; a late "answered" never overwrites them
    if (db && next) await updateCall(db, t.k, { status: next }, next === "answered" ? ["placed"] : ["placed", "answered"]);
  }
  return new Response(null, { status: 204 });
}
