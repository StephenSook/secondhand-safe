import { getDb } from "@/server/db/mongo";
import { verifyDealToken } from "@/server/deals/token";
import { visaCreds } from "@/server/visa/creds";
import { underLimit } from "@/server/visa/microform";
import { recallCallConfig } from "@/server/call/config";
import { last4, parseUsPhone, phoneHash, sealPhone } from "@/server/call/phone";
import { callsForDeal, saveOptIn } from "@/server/call/store";

const NO_STORE = { "cache-control": "no-store" };

/**
 * POST { token, phone }: "call me once if this item is recalled". The deal token proves the caller holds this deal,
 * and the number is bound to THAT deal server side: a call only ever goes to the number opted in on the same deal.
 * US numbers only. The number is sealed (AES-256-GCM) with a TTL and never returned; the answer carries the last 4.
 */
export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!underLimit(`recall-optin:${ip}`, 6)) return Response.json({ error: "Too many requests; wait a minute." }, { status: 429, headers: NO_STORE });
  const cfg = recallCallConfig();
  if (!cfg) return Response.json({ error: "The recall call is not configured on this deployment." }, { status: 503, headers: NO_STORE });
  const b = (await request.json().catch(() => null)) as { token?: unknown; phone?: unknown } | null;
  let secret: string;
  try { secret = visaCreds().secret; } catch { return Response.json({ error: "Not configured." }, { status: 503, headers: NO_STORE }); }
  const deal = typeof b?.token === "string" ? verifyDealToken(secret, b.token) : null;
  if (!deal) return Response.json({ error: "This deal token is invalid or expired." }, { status: 403, headers: NO_STORE });
  if (!underLimit(`recall-optin-deal:${deal.dealId}`, 3)) return Response.json({ error: "Too many changes to this number; wait a minute." }, { status: 429, headers: NO_STORE });
  const phone = parseUsPhone(b?.phone);
  if (!phone) return Response.json({ error: "Enter a US phone number, like (404) 555-0123." }, { status: 400, headers: NO_STORE });
  const db = await getDb().catch(() => null);
  if (!db) return Response.json({ error: "MongoDB Atlas did not answer; not saved." }, { status: 503, headers: NO_STORE });
  // once a call went out for this deal, its number is fixed
  const calls = await callsForDeal(db, deal.dealId);
  if (calls === null) return Response.json({ error: "MongoDB Atlas did not answer; not saved." }, { status: 503, headers: NO_STORE });
  if (calls.length) return Response.json({ error: "A call for this deal was already placed." }, { status: 409, headers: NO_STORE });
  const ok = await saveOptIn(db, { _id: deal.dealId, sealed: sealPhone(cfg.secret, phone), hash: phoneHash(cfg.secret, phone), last4: last4(phone) });
  if (!ok) return Response.json({ error: "MongoDB Atlas did not answer; not saved." }, { status: 503, headers: NO_STORE });
  return Response.json({ optedIn: true, last4: last4(phone) }, { headers: NO_STORE });
}
