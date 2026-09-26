import type { ChangeStream, ChangeStreamDocument } from "mongodb";
import { getDb } from "@/server/db/mongo";
import { boardDeal, type DealRecord } from "@/server/deals/store";
import { underLimit } from "@/server/visa/microform";

/**
 * Server-Sent Events pushed by a MongoDB Atlas change stream on `deals` (served at GET /api/stream).
 * `?deal=<dealId>` narrows it to one deal (the seller's view). Every `event: deal` carries boardDeal(doc): the
 * same allowlisted, listing-sanitized shape as GET /api/deals, never a Visa id. The SSE `id:` is the change's
 * resume token, so a reconnecting EventSource (Last-Event-ID) picks up where it left off.
 *
 * Limits: each open change stream holds one pooled connection (mongo.ts maxPoolSize 5), so at most
 * MAX_STREAMS per server instance; over that the answer is 503 and the page keeps polling. A stream ends itself
 * after STREAM_MS, inside the route's maxDuration (300 s), and the browser reconnects.
 */
export const MAX_STREAMS = 3;
export const STREAM_MS = 240_000;
const PING_MS = 15_000;
const DEAL_ID = /^shs-[0-9a-f-]{8,24}$/;

let active = 0;
/** open streams on this server instance */
export const activeStreams = () => active;

const ipOf = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
const unavailable = (error: string, status = 503) =>
  Response.json({ error, fallback: "poll /api/deals every 3 s" }, { status, headers: { "cache-control": "no-store" } });

/** A resume token is a small JSON object ({ _data: "..." }); anything else is ignored and the stream starts fresh. */
export function parseResume(raw: string | null): { _data: string } | undefined {
  if (!raw || raw.length > 2000) return undefined;
  try {
    const t = JSON.parse(raw) as unknown;
    if (t && typeof t === "object" && !Array.isArray(t) && Object.keys(t).length === 1) {
      const data = (t as { _data?: unknown })._data;
      if (typeof data === "string") return { _data: data };
    }
  } catch { /* not JSON */ }
  return undefined;
}

/** One SSE frame for a change, or null when there is nothing public to send. */
export function dealFrame(change: ChangeStreamDocument<DealRecord>): string | null {
  if (change.operationType !== "insert" && change.operationType !== "update" && change.operationType !== "replace") return null;
  const doc = change.fullDocument;
  if (!doc) return null; // an update whose document was deleted before the lookup
  return `id: ${JSON.stringify(change._id)}\nevent: deal\ndata: ${JSON.stringify(boardDeal(doc))}\n\n`;
}

export async function streamDeals(request: Request): Promise<Response> {
  if (!underLimit(`stream:${ipOf(request)}`, 20)) return unavailable("Too many stream connections; wait a minute.", 429);
  const url = new URL(request.url);
  const deal = url.searchParams.get("deal");
  if (deal !== null && !DEAL_ID.test(deal)) return Response.json({ error: "not a deal id" }, { status: 400 });
  if (active >= MAX_STREAMS) return unavailable("The live stream is at capacity on this server.");

  active += 1; // reserved before the first await, so concurrent requests cannot all pass the cap
  let released = false;
  const release = () => { if (!released) { released = true; active -= 1; } };

  let cs: ChangeStream<DealRecord, ChangeStreamDocument<DealRecord>>;
  try {
    const db = await getDb();
    if (!db) { release(); return unavailable("MongoDB Atlas is not configured on this deployment."); }
    const match: Record<string, unknown> = { operationType: { $in: ["insert", "update", "replace"] } };
    if (deal) match["documentKey._id"] = deal;
    cs = db.collection<DealRecord>("deals").watch<DealRecord>(
      [{ $match: match }, { $project: { "fullDocument.authId": 0, "fullDocument.sweepAttemptAt": 0, updateDescription: 0 } }],
      { fullDocument: "updateLookup", maxAwaitTimeMS: 5_000, resumeAfter: parseResume(request.headers.get("last-event-id") ?? url.searchParams.get("lastEventId")) },
    );
  } catch (e) {
    release();
    console.warn("[stream] could not open:", (e as Error).message);
    return unavailable("MongoDB Atlas did not answer.");
  }

  const enc = new TextEncoder();
  let finished = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  let stop: ReturnType<typeof setTimeout> | undefined;
  let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const send = (s: string) => {
    if (finished || !ctl) return;
    try { ctl.enqueue(enc.encode(s)); } catch { /* the reader went away */ }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(ping);
    clearTimeout(stop);
    request.signal.removeEventListener("abort", finish);
    // the pooled connection is free once the change stream is closed; never hold the slot longer than 10 s
    const fallback = setTimeout(release, 10_000);
    cs.close().catch(() => {}).finally(() => { clearTimeout(fallback); release(); });
    try { ctl?.close(); } catch { /* already closed or cancelled */ }
  };

  const pump = async () => {
    try {
      // the first round trip opens the change stream; only then is the page told it is live
      let change = await cs.tryNext();
      send(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ source: "MongoDB Atlas change stream", deal })}\n\n`);
      while (!finished) {
        if (change) {
          const f = dealFrame(change);
          if (f) send(f);
        }
        change = await cs.next();
      }
    } catch (e) {
      if (!finished) {
        console.warn("[stream] change stream ended:", (e as Error).message);
        // e.g. a resume token too old to resume from: an empty id clears Last-Event-ID, so the reconnect starts fresh
        send(`id:\nevent: reset\ndata: {}\n\n`);
      }
    } finally {
      finish();
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
      if (request.signal.aborted) { finish(); return; }
      request.signal.addEventListener("abort", finish);
      ping = setInterval(() => send(`: heartbeat\nevent: ping\ndata: {}\n\n`), PING_MS);
      stop = setTimeout(finish, STREAM_MS);
      void pump();
    },
    cancel() { finish(); },
  });

  return new Response(body, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
  });
}
