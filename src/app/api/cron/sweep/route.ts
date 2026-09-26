import { createHash, timingSafeEqual } from "node:crypto";
import { visaCreds } from "@/server/visa/creds";
import { heldBefore, recordSweep } from "@/server/deals/store";
import { HOLD_WINDOW_HOURS, planSweep, runSweep } from "@/server/deals/sweep";

export const maxDuration = 60;
const NO_STORE = { "cache-control": "no-store" };
const sha = (s: string) => createHash("sha256").update(s).digest();
/** Constant-time, length-independent compare (both sides hashed first). */
const bearerMatches = (given: string | null, expected: string) => !!given && timingSafeEqual(sha(given), sha(expected));

/**
 * GET: release every hold older than HOLD_WINDOW_HOURS (PLAN 5.4). Called once a day by Vercel Cron, which sends
 * `Authorization: Bearer $CRON_SECRET`; anything else is refused. Each run handles at most 25 deals, oldest first.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: "CRON_SECRET is not configured." }, { status: 503, headers: NO_STORE });
  const auth = request.headers.get("authorization") ?? "";
  if (!bearerMatches(auth.startsWith("Bearer ") ? auth.slice(7) : null, secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
  }
  let creds;
  try {
    creds = visaCreds();
  } catch {
    return Response.json({ error: "Visa is not configured on this deployment." }, { status: 503, headers: NO_STORE });
  }
  const now = new Date();
  const cutoff = new Date(now.getTime() - HOLD_WINDOW_HOURS * 3_600_000).toISOString();
  const held = await heldBefore(cutoff);
  if (!held) return Response.json({ error: "MongoDB Atlas did not answer; nothing was released." }, { status: 503, headers: NO_STORE });
  const outcomes = await runSweep(creds, planSweep(held, now));
  const recorded = [];
  for (const o of outcomes) {
    // UNKNOWN leaves the deal HELD (retried next run); everything else is written only if still HELD
    recorded.push({ ...o, recorded: o.status === "UNKNOWN" ? false : !!(await recordSweep(o.dealId, o.status, o.note)) });
  }
  return Response.json({ windowHours: HOLD_WINDOW_HOURS, examined: held.length, outcomes: recorded }, { headers: NO_STORE });
}
