import { getDb } from "@/server/db/mongo";
import { verifyDealToken } from "@/server/deals/token";
import { visaCreds } from "@/server/visa/creds";
import { underLimit } from "@/server/visa/microform";
import { recallCallConfig } from "@/server/call/config";
import { checkCode } from "@/server/call/verify";

const NO_STORE = { "cache-control": "no-store" };

/** POST { token, code }: step 2. The code spoken on the call (3 tries, 10 minutes) turns the opt-in on for this deal. */
export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!underLimit(`recall-verify:${ip}`, 10)) return Response.json({ error: "Too many requests; wait a minute." }, { status: 429, headers: NO_STORE });
  const cfg = recallCallConfig();
  if (!cfg) return Response.json({ error: "The recall call is not configured on this deployment." }, { status: 503, headers: NO_STORE });
  const b = (await request.json().catch(() => null)) as { token?: unknown; code?: unknown } | null;
  let secret: string;
  try { secret = visaCreds().secret; } catch { return Response.json({ error: "Not configured." }, { status: 503, headers: NO_STORE }); }
  const deal = typeof b?.token === "string" ? verifyDealToken(secret, b.token) : null;
  if (!deal) return Response.json({ error: "This deal token is invalid or expired." }, { status: 403, headers: NO_STORE });
  const db = await getDb().catch(() => null);
  if (!db) return Response.json({ error: "MongoDB Atlas did not answer." }, { status: 503, headers: NO_STORE });
  const r = await checkCode(db, cfg, deal.dealId, b?.code);
  if (r.state === "verified") return Response.json({ optedIn: true, last4: r.last4 }, { headers: NO_STORE });
  if (r.state === "wrong") return Response.json({ error: "That code is not right." }, { status: 400, headers: NO_STORE });
  if (r.state === "expired") return Response.json({ error: "That code expired or used its 3 tries. Ask for a new call in 10 minutes." }, { status: 410, headers: NO_STORE });
  return Response.json({ error: "MongoDB Atlas did not answer; the opt-in is not on." }, { status: 503, headers: NO_STORE });
}
