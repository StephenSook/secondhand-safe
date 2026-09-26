import { board } from "@/server/deals/store";

/** GET /api/deals: the most recent deals and totals by status, for the deal board. */
export async function GET() {
  const b = await board(20);
  if (!b) return Response.json({ error: "The deal store is not reachable on this deployment." }, { status: 503 });
  return Response.json(b, { headers: { "cache-control": "no-store" } });
}
