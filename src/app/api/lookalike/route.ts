import { lookalikesByVector, lookalikesForListing, parseVector } from "@/server/db/vector";
import { underLimit } from "@/server/visa/microform";

/**
 * POST { embedding: number[512] } or { listingId } -> the closest CPSC recall photos, by MongoDB Atlas Vector
 * Search (PLAN 5.2). The embedding is computed on the caller's device by the same CLIP model we indexed with.
 * GET ?listingId= works too, so anyone can curl it. A look-alike never decides the payment.
 */
const LISTING_ID = /^[a-z]+:[A-Za-z0-9._-]{1,80}$/;

async function answer(input: { embedding?: unknown; listingId?: unknown }, ip: string) {
  if (!underLimit(`lookalike:${ip}`, 60)) return Response.json({ error: "Too many look-ups; wait a minute." }, { status: 429 });
  let r;
  if (input.embedding !== undefined) {
    const v = parseVector(input.embedding);
    if (!v) return Response.json({ error: "embedding must be 512 finite numbers (CLIP ViT-B/32 image embedding)" }, { status: 400 });
    r = await lookalikesByVector(v);
  } else if (typeof input.listingId === "string" && LISTING_ID.test(input.listingId)) {
    r = await lookalikesForListing(input.listingId);
  } else {
    return Response.json({ error: "send { embedding } or { listingId } (for example ebay:287601074532)" }, { status: 400 });
  }
  if (!r.ok) {
    const status = r.reason === "not_found" ? 404 : 503;
    const error = r.reason === "not_found" ? "No stored photo embedding for that listing."
      : r.reason === "unconfigured" ? "MongoDB Atlas is not configured on this deployment." : "MongoDB Atlas did not answer. Nothing was decided.";
    return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
  }
  return Response.json(
    { matches: r.matches, note: "Closest CPSC recall photos by MongoDB Atlas Vector Search. A resemblance is a reason to read the label, never a verdict." },
    { headers: { "cache-control": "no-store" } },
  );
}

const ipOf = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

export async function POST(request: Request) {
  const b = (await request.json().catch(() => null)) as { embedding?: unknown; listingId?: unknown } | null;
  if (!b || typeof b !== "object") return Response.json({ error: "JSON body required" }, { status: 400 });
  return answer(b, ipOf(request));
}

export async function GET(request: Request) {
  const listingId = new URL(request.url).searchParams.get("listingId") ?? undefined;
  return answer({ listingId }, ipOf(request));
}
