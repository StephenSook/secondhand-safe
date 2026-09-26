import { describe, it, expect } from "vitest";
import { speak } from "@/server/voice/elevenlabs";

/** Live: real ElevenLabs call. Runs with `npm run test:live` when ELEVENLABS_API_KEY is set. */
describe.skipIf(!process.env.ELEVENLABS_API_KEY)("ElevenLabs live", () => {
  it.each(["en", "es"] as const)("speaks a recall verdict in %s as MP3", async (lang) => {
    const buf = new Uint8Array(await speak("RECALL_MATCH", lang, process.env.ELEVENLABS_API_KEY!));
    expect(buf.length).toBeGreaterThan(5000);
    const id3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
    const frame = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
    expect(id3 || frame).toBe(true);
  }, 60_000);
});
