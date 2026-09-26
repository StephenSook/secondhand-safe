import { getDb } from "@/server/db/mongo";
import { verifyDealToken } from "@/server/deals/token";
import { visaCreds } from "@/server/visa/creds";
import { underLimit } from "@/server/visa/microform";
import { recallCallConfig } from "@/server/call/config";
import { last4, parseUsPhone } from "@/server/call/phone";
import { callsForDeal } from "@/server/call/store";
import { startCodeCall } from "@/server/call/verify";

const NO_STORE = { "cache-control": "no-store" };
const REFUSED: Record<string, [number, string]> = {
  "in-flight": [409, "A code call for this deal is already on its way. Enter that code, or try again in 10 minutes."],
  "capped-verify": [429, "This number already got its code calls today."],
  "capped-number": [429, "This number already got its calls today."],
  "capped-daily": [429, "Today's call limit is reached. Try again tomorrow."],
  "no-db": [503, "MongoDB Atlas did not answer; nothing was saved and no call was placed."],
  failed: [502, "The code call could not be placed. Check the number and try again."],
};

/**
 * POST { token, phone }: step 1 of "call me once if this item is recalled". The deal token proves the caller holds
 * this deal; to prove they hold the PHONE, Lullabuy calls it with a 4-digit code (POST /api/recall-call/verify turns
 * the opt-in on). US numbers only; the number is sealed server side and never returned (the answer has the last 4).
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
  if (!phone) return Response.json({ error: "Enter a US phone number (no Canada, Caribbean or premium numbers)." }, { status: 400, headers: NO_STORE });
  const db = await getDb().catch(() => null);
  if (!db) return Response.json({ error: REFUSED["no-db"][1] }, { status: 503, headers: NO_STORE });
  // once a call went out for this deal, its number is fixed
  const calls = await callsForDeal(db, deal.dealId);
  if (calls === null) return Response.json({ error: REFUSED["no-db"][1] }, { status: 503, headers: NO_STORE });
  if (calls.length) return Response.json({ error: "A call for this deal was already placed." }, { status: 409, headers: NO_STORE });
  const r = await startCodeCall(db, cfg, deal.dealId, phone);
  if (r.state !== "calling") {
    const [status, error] = REFUSED[r.state];
    return Response.json({ error }, { status, headers: NO_STORE });
  }
  return Response.json({ verifying: true, last4: last4(phone) }, { headers: NO_STORE });
}
