import { createHash, timingSafeEqual } from "node:crypto";
import { visaCreds } from "@/server/visa/creds";
import { heldBefore, recordSweep, recordSweepAttempt } from "@/server/deals/store";
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
  const started = Date.now();
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
  const recorded: { dealId: string; status: string; recorded: boolean }[] = [];
  // Budget from request entry. After the last start: stamp (up to 8 s) + Visa reversal (20 s timeout) + record
  // (8 s) = 36 s, so no new deal starts after 20 s and the worst case is 56 s, inside maxDuration (60 s).
  await runSweep(creds, planSweep(held, now), {
    deadline: started + 20_000,
    stamp: (id) => recordSweepAttempt(id),
    record: async (o) => {
      const ok = o.status === "UNKNOWN" ? !!(await recordSweepAttempt(o.dealId)) : !!(await recordSweep(o.dealId, o.status, o.note));
      recorded.push({ dealId: o.dealId, status: o.status, recorded: ok });
    },
  });
  return Response.json({ windowHours: HOLD_WINDOW_HOURS, examined: held.length, outcomes: recorded }, { headers: NO_STORE });
}
