import { getDb } from "@/server/db/mongo";
import { verifyDealToken } from "@/server/deals/token";
import { visaCreds } from "@/server/visa/creds";
import { underLimit } from "@/server/visa/microform";
import { recallCallConfig } from "@/server/call/config";
import { callsForDeal, getOptIn } from "@/server/call/store";

const NO_STORE = { "cache-control": "no-store" };

/** POST { token }: the buyer's own view of the recall call for this deal (last 4 digits only, never the number). */
export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!underLimit(`recall-status:${ip}`, 40)) return Response.json({ error: "Too many requests; wait a minute." }, { status: 429, headers: NO_STORE });
  if (!recallCallConfig()) return Response.json({ error: "The recall call is not configured on this deployment." }, { status: 503, headers: NO_STORE });
  const b = (await request.json().catch(() => null)) as { token?: unknown } | null;
  let secret: string;
  try { secret = visaCreds().secret; } catch { return Response.json({ error: "Not configured." }, { status: 503, headers: NO_STORE }); }
  const deal = typeof b?.token === "string" ? verifyDealToken(secret, b.token) : null;
  if (!deal) return Response.json({ error: "This deal token is invalid or expired." }, { status: 403, headers: NO_STORE });
  const db = await getDb().catch(() => null);
  const calls = db ? await callsForDeal(db, deal.dealId) : null;
  if (!db || !calls) return Response.json({ error: "MongoDB Atlas did not answer." }, { status: 503, headers: NO_STORE });
  const opt = await getOptIn(db, deal.dealId);
  return Response.json({
    optedIn: !!opt, last4: opt?.last4 ?? null,
    calls: calls.map((c) => ({ reason: c.reason, status: c.status, last4: c.last4, at: c.placedAt ?? c.updatedAt, mode: c.mode ?? null })),
  }, { headers: NO_STORE });
}
