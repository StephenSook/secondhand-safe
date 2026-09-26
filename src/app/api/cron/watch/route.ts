import { createHash, timingSafeEqual } from "node:crypto";
import { flagPostSaleRecall, recordPassportAssetRecall, watchedSales } from "@/server/deals/store";
import { updatePassportStatus } from "@/server/solana/core";
import { reconcileMints } from "@/server/solana/mints";
import { recheckSales } from "@/server/watch/recheck";
import { notify } from "@/server/watch/push";

export const maxDuration = 300;
/** Chain work stops being started once less than this remains: one update can take balance 8 s + fetch 10 s + a 40 s
 *  send + an 8 s Atlas write (66 s), so 90 s leaves headroom. Anything not started runs on the next day's cron. */
const CHAIN_HEADROOM_MS = 90_000;
/** at most this many on-chain recall updates per run, one at a time (no burst of RPC sends) */
const CHAIN_UPDATES_PER_RUN = 3;
/** at most this many recall hits notified and flagged per run (each can wait on a push for 8 s); the rest wait a day */
const RECALL_HITS_PER_RUN = 50;
const NO_STORE = { "cache-control": "no-store" };
const sha = (s: string) => createHash("sha256").update(s).digest();
const bearerMatches = (given: string | null, expected: string) => !!given && timingSafeEqual(sha(given), sha(expected));

/**
 * GET (Vercel Cron, Bearer CRON_SECRET): the real recall watch. Re-checks every captured sale's label against the
 * current recall index; a sale that now matches a recall is flagged on its deal record and its watching browsers
 * are notified. Idempotent: a sale is flagged once per recall. Mint claims a pickup left open are reconciled first,
 * then recall hits (at most RECALL_HITS_PER_RUN, under the time gate), then the on-chain passports follow the deals.
 */
export async function GET(request: Request) {
  const began = Date.now();
  const canStartChainWork = () => began + maxDuration * 1000 - Date.now() >= CHAIN_HEADROOM_MS;
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: "CRON_SECRET is not configured." }, { status: 503, headers: NO_STORE });
  const auth = request.headers.get("authorization") ?? "";
  if (!bearerMatches(auth.startsWith("Bearer ") ? auth.slice(7) : null, secret)) return Response.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
  const sales = await watchedSales();
  if (!sales) return Response.json({ error: "MongoDB Atlas did not answer; nothing was checked." }, { status: 503, headers: NO_STORE });
  // mint claims a pickup left pending or uncertain go first: reconcile is itself bounded (a per-run cap and the time
  // gate), so the recall loop below can never starve it
  const mints = await reconcileMints({ canStartChainWork });
  const hits = recheckSales(sales);
  const out = [];
  const deferredHits: string[] = [];
  for (const h of hits) {
    // a hit not reached this run is not flagged, so the next run finds it again
    if (out.length >= RECALL_HITS_PER_RUN || !canStartChainWork()) { deferredHits.push(h.dealId); continue; }
    // notify first; the flag (the idempotency key) is written only when delivery did not fail outright, so a push
    // outage is retried on the next run instead of being skipped for ever
    const push = await notify([h.dealId], { title: `Recall announced: CPSC ${h.recallNumber}`, body: `${h.title.slice(0, 120)}. Tap for what to do.`, url: "/deal/{deal}", tag: `recall-${h.recallNumber}` })
      .catch(() => ({ sent: 0, failed: 1, subs: 1 }));
    const delivered = push.subs === 0 || push.sent > 0;
    const newly = delivered ? await flagPostSaleRecall(h.dealId, { recallNumber: h.recallNumber, title: h.title, url: h.url }, push.sent) : false;
    out.push({ dealId: h.dealId, recallNumber: h.recallNumber, flagged: !!newly, notified: push.sent, retryTomorrow: !delivered });
  }
  // the on-chain passport follows the deal record: every sale with a Core asset whose confirmed recall differs from the
  // deal's current recall (a newly flagged one, a later second recall, or an earlier update that did not land)
  const recallOf = new Map<string, string>();
  for (const s of sales) if (s.postSaleRecall?.recallNumber) recallOf.set(s._id, s.postSaleRecall.recallNumber);
  for (const o of out) if (o.flagged) recallOf.set(o.dealId, o.recallNumber);
  const pending = sales.filter((s) => s.passportAsset && recallOf.has(s._id) && s.passportAssetRecall !== recallOf.get(s._id));
  const chain: Record<string, unknown>[] = [];
  let begun = 0;
  for (const s of pending) {
    const asset = s.passportAsset as string, recall = recallOf.get(s._id) as string;
    if (begun >= CHAIN_UPDATES_PER_RUN || !canStartChainWork()) { chain.push({ dealId: s._id, asset, recall, deferred: true }); continue; }
    begun++;
    // updatePassportStatus reads the asset first and sends nothing when an earlier (ambiguous) update already landed
    const r = await updatePassportStatus(asset, "RECALLED_AFTER_SALE", { recall });
    const recorded = r.ok ? await recordPassportAssetRecall(s._id, asset, recall) : null;
    chain.push({ dealId: s._id, asset, recall, updated: r.ok, ...(r.ok ? { signature: r.signature, recorded: !!recorded } : { reason: r.reason }) });
  }
  return Response.json({ checked: sales.length, hits: out, deferredHits, passportAssets: chain, mints }, { headers: NO_STORE });
}
