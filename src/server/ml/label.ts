/**
 * Label reader (PLAN 1.8): Gemini vision returns ONLY what is printed on the label, as JSON with boxes.
 * A field it cannot read is omitted, and "readable" is false when neither a model number nor a UPC is legible.
 * Never a guess: every value is also required to be short, printable and label-shaped.
 */
export const LABEL_MODEL = "gemini-3.5-flash"; // 3.8-flash measured >120 s per call; 3.5-flash ~3 s

export interface LabelBox { field: "brand" | "model" | "batch" | "date" | "upc"; x: number; y: number; w: number; h: number }
export interface LabelRead {
  readable: boolean;
  brand?: string;
  model?: string;
  batch?: string;
  date?: string;
  upc?: string;
  productType?: string;
  boxes: LabelBox[];
  ms: number;
}

const PROMPT = `You are reading the manufacturer's label on a used baby product (crib, bassinet, sleeper, high chair, car seat, stroller, play yard).
Return JSON only. Copy values EXACTLY as printed; do not correct, complete or infer them.
- brand: brand name printed on the label.
- model: the model / style / item number.
- batch: production batch, lot or date code, if printed.
- date: manufacture date as printed.
- upc: the digits under the barcode, if legible.
- productType: what the product is, 1-4 words, from the label text or the photo.
- boxes: for each field you returned, its bounding box as fractions of the image (x, y, w, h between 0 and 1).
If a value is not clearly legible, leave it out. Set readable=false if neither model nor upc is legible.`;

const clean = (v: unknown, max = 40) => {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && s.length <= max && /^[\x20-\x7E]+$/.test(s) ? s : undefined;
};

export async function readLabel(base64: string, mime: string, key: string, fetchImpl: typeof fetch = fetch): Promise<LabelRead> {
  const t0 = Date.now();
  // key: an AI Studio API key, or "vertex:<project>:<access token>" for Vertex AI on a project whose billing
  // account carries the Gemini credits (used for local verification with `gcloud auth print-access-token`)
  const vertex = key.startsWith("vertex:") ? key.split(":") : null;
  const url = vertex
    ? `https://aiplatform.googleapis.com/v1/projects/${vertex[1]}/locations/global/publishers/google/models/${LABEL_MODEL}:generateContent`
    : `https://generativelanguage.googleapis.com/v1beta/models/${LABEL_MODEL}:generateContent`;
  const auth: Record<string, string> = vertex ? { authorization: `Bearer ${vertex.slice(2).join(":")}` } : { "x-goog-api-key": key };
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: PROMPT }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            readable: { type: "BOOLEAN" }, brand: { type: "STRING" }, model: { type: "STRING" }, batch: { type: "STRING" },
            date: { type: "STRING" }, upc: { type: "STRING" }, productType: { type: "STRING" },
            boxes: { type: "ARRAY", items: { type: "OBJECT", properties: {
              field: { type: "STRING", enum: ["brand", "model", "batch", "date", "upc"] },
              x: { type: "NUMBER" }, y: { type: "NUMBER" }, w: { type: "NUMBER" }, h: { type: "NUMBER" } },
              required: ["field", "x", "y", "w", "h"] } },
          },
          required: ["readable", "boxes"],
        },
      },
    }),
  });
  if (!res.ok) {
    const msg = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? "";
    throw new Error(`Gemini HTTP ${res.status} ${msg.slice(0, 120)}`);
  }
  const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const raw = JSON.parse(j.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}") as Record<string, unknown>;
  const upc = clean(raw.upc, 20)?.replace(/\D/g, "");
  const out: LabelRead = {
    brand: clean(raw.brand), model: clean(raw.model), batch: clean(raw.batch), date: clean(raw.date),
    upc: upc && upc.length >= 11 ? upc : undefined, productType: clean(raw.productType, 60),
    boxes: (Array.isArray(raw.boxes) ? raw.boxes : [])
      .filter((b): b is LabelBox => !!b && typeof b === "object" && ["brand", "model", "batch", "date", "upc"].includes((b as LabelBox).field))
      .map((b) => ({ field: b.field, x: clamp(b.x), y: clamp(b.y), w: clamp(b.w), h: clamp(b.h) })),
    readable: false,
    ms: Date.now() - t0,
  };
  out.readable = !!(out.model || out.upc);
  return out;
}

const clamp = (v: unknown) => Math.min(1, Math.max(0, Number(v) || 0));
