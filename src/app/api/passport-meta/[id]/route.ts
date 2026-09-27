import { DEAL_ID_RE, passportMeta } from "@/server/solana/meta";

/** GET /api/passport-meta/<dealId> */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!DEAL_ID_RE.test(id)) return Response.json({ error: "not a deal id" }, { status: 400 });
  const base = process.env.PUBLIC_BASE_URL?.trim() || new URL(request.url).origin;
  return Response.json(passportMeta(id, base), { headers: { "cache-control": "public, max-age=3600" } });
}
