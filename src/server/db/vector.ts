import { getDb } from "@/server/db/mongo";

/**
 * MongoDB Atlas Vector Search (PLAN 5.2): "this photo looks like the photo in CPSC recall X".
 *
 * One collection, `image_vectors`, holds a CLIP ViT-B/32 embedding (transformers.js q8, the SAME runtime the
 * phone runs) for the first photo of every CPSC recall in our index (`kind: "recall"`) and for every scanned
 * listing photo (`kind: "listing"`). One vectorSearch index (`img_vec`, cosine, 512 dims, `kind` as a filter)
 * answers both questions, which matters because a free M0 cluster allows only three search indexes.
 *
 * A look-alike is a reason to read the label closely. It never decides the payment (D2): only the label
 * check against the recall index moves money.
 */
export const VECTOR_COLLECTION = "image_vectors";
export const VECTOR_INDEX = "img_vec";
export const DIMS = 512;

/** Cosine at or above this is shown as a strong resemblance. Calibrated on our listings (see seed script). */
export const STRONG_COSINE = Number(process.env.LOOKALIKE_STRONG_COSINE ?? "0.9");

export interface LookAlike {
  recallNumber: string;
  title: string;
  productType: string | null;
  recallDate: string | null;
  notice: string;
  image: string;
  /** cosine similarity in [-1, 1] (Atlas reports (1 + cos) / 2; converted here) */
  cosine: number;
  strong: boolean;
}

export type LookupResult =
  | { ok: true; matches: LookAlike[] }
  | { ok: false; reason: "unconfigured" | "not_found" | "unavailable"; detail?: string };

/** A usable query vector: exactly 512 finite numbers with a non-zero length. */
export function parseVector(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length !== DIMS) return null;
  let norm = 0;
  for (const x of v) {
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    norm += x * x;
  }
  return norm > 1e-6 ? (v as number[]) : null;
}

export function pipeline(queryVector: number[], limit: number) {
  return [
    { $vectorSearch: { index: VECTOR_INDEX, path: "embedding", queryVector, numCandidates: Math.max(20 * limit, 100), limit, filter: { kind: "recall" } } },
    { $project: { _id: 0, recallNumber: 1, title: 1, productType: 1, recallDate: 1, notice: 1, image: 1, score: { $meta: "vectorSearchScore" } } },
  ];
}

export function toLookAlike(d: Record<string, unknown>): LookAlike {
  const cosine = Math.round((2 * Number(d.score) - 1) * 1000) / 1000;
  return {
    recallNumber: String(d.recallNumber), title: String(d.title), productType: (d.productType as string) ?? null,
    recallDate: (d.recallDate as string) ?? null, notice: String(d.notice), image: String(d.image), cosine, strong: cosine >= STRONG_COSINE,
  };
}

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`Atlas did not answer in ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(t);
  }
}

/** Closest recall photos to an embedding the caller computed (the judge's phone does this on-device). */
export async function lookalikesByVector(vec: number[], limit = 3): Promise<LookupResult> {
  const db = await getDb().catch(() => null);
  if (!db) return process.env.MONGODB_URI ? { ok: false, reason: "unavailable", detail: "no connection" } : { ok: false, reason: "unconfigured" };
  try {
    const docs = await withDeadline(db.collection(VECTOR_COLLECTION).aggregate(pipeline(vec, limit)).toArray(), 6_000);
    return { ok: true, matches: docs.map(toLookAlike) };
  } catch (e) {
    return { ok: false, reason: "unavailable", detail: (e as Error).message };
  }
}

/** Closest recall photos to a scanned listing's photo, using the embedding stored with that listing. */
export async function lookalikesForListing(listingId: string, limit = 3): Promise<LookupResult> {
  const db = await getDb().catch(() => null);
  if (!db) return process.env.MONGODB_URI ? { ok: false, reason: "unavailable", detail: "no connection" } : { ok: false, reason: "unconfigured" };
  try {
    const doc = await withDeadline(db.collection(VECTOR_COLLECTION).findOne({ _id: `listing:${listingId}` as never, kind: "listing" }, { projection: { embedding: 1 } }), 4_000);
    const vec = parseVector(doc?.embedding);
    if (!vec) return { ok: false, reason: "not_found" };
    return lookalikesByVector(vec, limit);
  } catch (e) {
    return { ok: false, reason: "unavailable", detail: (e as Error).message };
  }
}
