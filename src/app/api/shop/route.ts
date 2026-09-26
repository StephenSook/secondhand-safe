import { shop } from "@/server/shop/agent";
import { shopGeminiKey } from "@/server/shop/key";
import { underLimit } from "@/server/visa/microform";

/** POST { q } -> Gemini-parsed search over real scanned listings, each pre-screened (recall index + model + review). */
export async function POST(request: Request) {
  const b = (await request.json().catch(() => null)) as { q?: unknown } | null;
  const q = typeof b?.q === "string" ? b.q.trim().slice(0, 400) : "";
  if (q.length < 2) return Response.json({ error: "Say or type what you are looking for." }, { status: 400 });
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!underLimit(`shop:${ip}`, 30)) return Response.json({ error: "Too many searches; wait a minute." }, { status: 429 });
  const key = await shopGeminiKey();
  const t0 = Date.now();
  const r = await shop(q, key);
  return Response.json({ ...r, ms: Date.now() - t0 }, { headers: { "cache-control": "no-store" } });
}
