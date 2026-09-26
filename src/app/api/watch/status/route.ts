import { watchedSales } from "@/server/deals/store";

/** GET: counts only (how many captured sales are watched, how many real post-sale recalls were found). */
export async function GET() {
  const sales = await watchedSales();
  if (!sales) return Response.json({ error: "MongoDB Atlas did not answer." }, { status: 503, headers: { "cache-control": "no-store" } });
  return Response.json({ watchedSales: sales.length, flagged: sales.filter((s) => s.postSaleRecall).length }, { headers: { "cache-control": "no-store" } });
}
