import { createHash, timingSafeEqual } from "node:crypto";
import { flagPostSaleRecall, watchedSales } from "@/server/deals/store";
import { recheckSales } from "@/server/watch/recheck";
import { notify } from "@/server/watch/push";
import { recallCall } from "@/server/call/trigger";

export const maxDuration = 60;
const NO_STORE = { "cache-control": "no-store" };
const sha = (s: string) => createHash("sha256").update(s).digest();
const bearerMatches = (given: string | null, expected: string) => !!given && timingSafeEqual(sha(given), sha(expected));

/**
 * GET (Vercel Cron, Bearer CRON_SECRET): the real recall watch. Re-checks every captured sale's label against the
 * current recall index; a sale that now matches a recall is flagged on its deal record and its watching browsers
 * are notified. Idempotent: a sale is flagged once per recall.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: "CRON_SECRET is not configured." }, { status: 503, headers: NO_STORE });
  const auth = request.headers.get("authorization") ?? "";
  if (!bearerMatches(auth.startsWith("Bearer ") ? auth.slice(7) : null, secret)) return Response.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
  const sales = await watchedSales();
  if (!sales) return Response.json({ error: "MongoDB Atlas did not answer; nothing was checked." }, { status: 503, headers: NO_STORE });
  const hits = recheckSales(sales);
  const out = [];
  for (const h of hits) {
    // notify first; the flag (the idempotency key) is written only when delivery did not fail outright, so a push
    // outage is retried on the next run instead of being skipped for ever
    const push = await notify([h.dealId], { title: `Recall announced: CPSC ${h.recallNumber}`, body: `${h.title.slice(0, 120)}. Tap for what to do.`, url: "/deal/{deal}", tag: `recall-${h.recallNumber}` })
      .catch(() => ({ sent: 0, failed: 1, subs: 1 }));
    const delivered = push.subs === 0 || push.sent > 0;
    const newly = delivered ? await flagPostSaleRecall(h.dealId, { recallNumber: h.recallNumber, title: h.title, url: h.url }, push.sent) : false;
    // the recall call (opt-in): once per sale per recall, capped; its result never changes the flag above
    const call = newly ? (await recallCall(h.dealId, { kind: "postsale", recallNumber: h.recallNumber })).state : "not-flagged";
    out.push({ dealId: h.dealId, recallNumber: h.recallNumber, flagged: !!newly, notified: push.sent, retryTomorrow: !delivered, call });
  }
  return Response.json({ checked: sales.length, hits: out }, { headers: NO_STORE });
}
