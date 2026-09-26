/**
 * One JSON-mode Gemini call. key: an AI Studio key, or "vertex:<project>:<access token>" (what resolveGeminiKey
 * returns in production). Same endpoints and auth as the label reader.
 */
export const AGENT_MODEL = "gemini-3.5-flash";

export async function geminiJson<T>(key: string, prompt: string, schema: object, fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): Promise<T> {
  const vertex = key.startsWith("vertex:") ? key.split(":") : null;
  const url = vertex
    ? `https://aiplatform.googleapis.com/v1/projects/${vertex[1]}/locations/global/publishers/google/models/${AGENT_MODEL}:generateContent`
    : `https://generativelanguage.googleapis.com/v1beta/models/${AGENT_MODEL}:generateContent`;
  const auth: Record<string, string> = vertex ? { authorization: `Bearer ${vertex.slice(2).join(":")}` } : { "x-goog-api-key": key };
  const res = await fetchImpl(url, {
    method: "POST", signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: schema },
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${j.error?.message?.slice(0, 120) ?? ""}`);
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content");
  return JSON.parse(text) as T;
}
