import { watchedSales } from "@/server/deals/store";
import { fold } from "@/server/recalls/match";
import { parseHypothetical, simulateRecall } from "@/server/watch/recheck";
import { notify } from "@/server/watch/push";
import { verifyDealToken } from "@/server/deals/token";
import { visaCreds } from "@/server/visa/creds";
import { underLimit } from "@/server/visa/microform";

const NO_STORE = { "cache-control": "no-store" };

/**
 * POST { model, batch?, token? }: a SIMULATION for the demo. "What if CPSC announced a recall for this model tomorrow?"
 * Every real captured sale in MongoDB Atlas is re-checked with the matcher's folding; the answer is a COUNT (no sale
 * ids or labels leave the server). Only the caller's OWN sale (proved by its deal token) can receive a notification,
 * titled as a simulation, so nobody can send notifications to other people. Nothing is written to any sale.
 */
export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!underLimit(`watch-sim:${ip}`, 10)) return Response.json({ error: "Too many simulations; wait a minute." }, { status: 429, headers: NO_STORE });
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const h = parseHypothetical(body);
  if (!h) return Response.json({ error: "model is required (at least 4 letters or digits)" }, { status: 400, headers: NO_STORE });
  const sales = await watchedSales();
  if (!sales) return Response.json({ error: "MongoDB Atlas did not answer; nothing was simulated." }, { status: 503, headers: NO_STORE });
  const hits = simulateRecall(sales, h);
  let secret: string | null = null;
  try { secret = visaCreds().secret; } catch { secret = null; }
  const mine = secret && typeof body?.token === "string" ? verifyDealToken(secret, body.token) : null;
  const myHit = mine ? hits.find((x) => x.dealId === mine.dealId) : undefined;
  const push = myHit
    ? await notify([myHit.dealId], {
        title: "Simulated recall (demo)", tag: `sim-${fold(h.model)}`,
        body: `If CPSC recalled model ${h.model}, the item you bought would be affected. This is a demonstration, not a real recall.`,
        url: "/deal/{deal}",
      }).catch(() => ({ sent: 0, failed: 0, subs: 0 }))
    : { sent: 0, failed: 0, subs: 0 };
  return Response.json({
    simulation: true, hypothetical: h, watchedSales: sales.length, affected: hits.length,
    yourSale: mine ? { affected: !!myHit, batchCheck: myHit?.batchCheck ?? null, notified: push.sent } : null,
  }, { headers: NO_STORE });
}
