import { trustStats } from "@/server/deals/trust";

/** GET: the Trust and Safety console numbers as JSON (PLAN 5.8), computed live from MongoDB Atlas. */
export async function GET() {
  const s = await trustStats();
  if (!s) return Response.json({ error: "MongoDB Atlas did not answer; no numbers are shown." }, { status: 503, headers: { "cache-control": "no-store" } });
  return Response.json(s, { headers: { "cache-control": "no-store" } });
}
