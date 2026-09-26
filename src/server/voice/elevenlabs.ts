import type { VerdictKind } from "@/core/verdict";

/** Spoken verdicts (PLAN 2.11). Premade ElevenLabs voice "Sarah"; eleven_flash_v2_5 speaks English and Spanish. */
export const VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
export const TTS_MODEL = "eleven_flash_v2_5";

export type Lang = "en" | "es";

const LINES: Record<Lang, Record<VerdictKind, string>> = {
  en: {
    RECALL_MATCH: "Stop. This product is on a federal recall. The payment will be reversed, and you keep your money.",
    BANNED_TYPE: "Stop. This type of baby product is banned from sale. The payment will be reversed.",
    NO_MATCH: "No recall match on this label. The payment goes through to the seller.",
    NEEDS_CHECK: "Hold on. This one needs a closer look before any money moves.",
    UNREADABLE: "I could not read the label. Take a closer photo, or type the model number.",
  },
  es: {
    RECALL_MATCH: "Alto. Este producto tiene un retiro federal del mercado. El pago se revierte y usted conserva su dinero.",
    BANNED_TYPE: "Alto. La venta de este tipo de producto para bebé está prohibida. El pago se revierte.",
    NO_MATCH: "No hay retiros para esta etiqueta. El pago pasa al vendedor.",
    NEEDS_CHECK: "Un momento. Esto necesita una revisión antes de mover el dinero.",
    UNREADABLE: "No pude leer la etiqueta. Tome una foto más de cerca o escriba el número de modelo.",
  },
};

export const lineFor = (kind: VerdictKind, lang: Lang) => LINES[lang][kind];

export async function speak(kind: VerdictKind, lang: Lang, key: string, fetchImpl: typeof fetch = fetch): Promise<ArrayBuffer> {
  const res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text: lineFor(kind, lang), model_id: TTS_MODEL, language_code: lang,
      voice_settings: { stability: 0.55, similarity_boost: 0.75 } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.arrayBuffer();
}
