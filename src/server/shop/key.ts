import { resolveGeminiKey } from "@/server/ml/gcpToken";

/** The Gemini credential the shopping agent reads requests with, or null (the search then falls back to keywords). */
export async function shopGeminiKey(): Promise<string | null> {
  const raw = process.env.GEMINI_API_KEY?.trim();
  if (!raw) return null;
  try {
    return await resolveGeminiKey(raw);
  } catch (e) {
    console.warn("[shop] Gemini credentials failed:", (e as Error).message);
    return null;
  }
}
