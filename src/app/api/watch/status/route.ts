import { watchedSales } from "@/server/deals/store";

/** GET: how many captured sales the recall watch re-checks, and the real post-sale recalls it has found. */
export async function GET() {
  const sales = await watchedSales();
  if (!sales) return Response.json({ error: "MongoDB Atlas did not answer." }, { status: 503, headers: { "cache-control": "no-store" } });
  const flagged = sales.filter((s) => s.postSaleRecall).map((s) => ({ dealId: s._id, recall: s.postSaleRecall }));
  return Response.json({ watchedSales: sales.length, flagged }, { headers: { "cache-control": "no-store" } });
}
