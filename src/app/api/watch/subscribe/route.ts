import { verifyDealToken } from "@/server/deals/token";
import { visaCreds } from "@/server/visa/creds";
import { parseSubscription, saveSubscription, vapid } from "@/server/watch/push";
import { underLimit } from "@/server/visa/microform";

/** POST { token, subscription }: watch this sale for recalls. The deal token proves the caller holds this sale. */
export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!underLimit(`watch-sub:${ip}`, 20)) return Response.json({ error: "Too many requests; wait a minute." }, { status: 429 });
  if (!vapid()) return Response.json({ error: "Recall-watch notifications are not configured on this deployment." }, { status: 503 });
  const b = (await request.json().catch(() => null)) as { token?: unknown; subscription?: unknown } | null;
  const sub = parseSubscription(b?.subscription);
  if (!sub) return Response.json({ error: "subscription must be a browser push subscription from a known push service" }, { status: 400 });
  let secret: string;
  try { secret = visaCreds().secret; } catch { return Response.json({ error: "Not configured." }, { status: 503 }); }
  const deal = typeof b?.token === "string" ? verifyDealToken(secret, b.token) : null;
  if (!deal) return Response.json({ error: "This deal token is invalid or expired." }, { status: 403 });
  const ok = await saveSubscription(deal.dealId, sub).catch(() => false);
  if (!ok) return Response.json({ error: "MongoDB Atlas did not answer; not subscribed." }, { status: 503 });
  return Response.json({ watching: deal.dealId }, { headers: { "cache-control": "no-store" } });
}
