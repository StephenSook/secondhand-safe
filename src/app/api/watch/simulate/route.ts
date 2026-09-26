import { publicListing, watchedSales } from "@/server/deals/store";
import { parseHypothetical, simulateRecall } from "@/server/watch/recheck";
import { notify } from "@/server/watch/push";
import { underLimit } from "@/server/visa/microform";

const NO_STORE = { "cache-control": "no-store" };

/**
 * POST { model, batch? }: a SIMULATION for the demo. "What if CPSC announced a recall for this model tomorrow?" It
 * re-checks every real captured sale in MongoDB Atlas with the same folding the matcher uses, returns the sales it
 * would catch, and sends each one's watching browser a notification titled as a simulation. Nothing is written to
 * any deal; the real, recorded path is the daily recheck against the recall index (/api/cron/watch).
 */
export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!underLimit(`watch-sim:${ip}`, 10)) return Response.json({ error: "Too many simulations; wait a minute." }, { status: 429, headers: NO_STORE });
  const h = parseHypothetical(await request.json().catch(() => null));
  if (!h) return Response.json({ error: "model is required (at least 4 letters or digits)" }, { status: 400, headers: NO_STORE });
  const sales = await watchedSales();
  if (!sales) return Response.json({ error: "MongoDB Atlas did not answer; nothing was simulated." }, { status: 503, headers: NO_STORE });
  const hits = simulateRecall(sales, h);
  const push = await notify(hits.map((x) => x.dealId), {
    title: "Simulated recall (demo)", tag: `sim-${h.model}`,
    body: `If CPSC recalled model ${h.model}, the item you bought would be affected. This is a demonstration, not a real recall.`,
    url: "/deal/{deal}",
  }).catch(() => ({ sent: 0, failed: 0 }));
  return Response.json({ simulation: true, hypothetical: h, watchedSales: sales.length, matches: hits.map((x) => ({ ...x, listing: publicListing(x.listing) })), notified: push }, { headers: NO_STORE });
}
