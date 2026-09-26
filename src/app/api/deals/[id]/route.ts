import { getDeal } from "@/server/deals/store";

/** GET /api/deals/<dealId>: the deal's live status and timeline, for the seller's phone. No card data, no Visa ids. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^shs-[0-9a-f-]{8,24}$/.test(id)) return Response.json({ error: "not a deal id" }, { status: 400 });
  const r = await getDeal(id);
  if (r.state === "unavailable") return Response.json({ error: "The deal store is not reachable right now." }, { status: 503 });
  if (r.state === "missing") return Response.json({ error: "No record of this deal (its hold may not have been recorded)." }, { status: 404 });
  return Response.json(r.deal, { headers: { "cache-control": "no-store" } });
}
