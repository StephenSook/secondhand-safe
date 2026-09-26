import { getDeal } from "@/server/deals/store";

/** GET /api/deals/<dealId>: the deal's live status and timeline, for the seller's phone. No card data, no Visa ids. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^shs-[0-9a-f-]{8,24}$/.test(id)) return Response.json({ error: "not a deal id" }, { status: 400 });
  const d = await getDeal(id);
  if (d === undefined) return Response.json({ error: "The deal store is not reachable on this deployment." }, { status: 503 });
  if (d === null) return Response.json({ error: "No such deal." }, { status: 404 });
  return Response.json(d, { headers: { "cache-control": "no-store" } });
}
