import { describe, it, expect, afterEach, vi } from "vitest";
import { GET } from "@/app/api/voice/route";
import { summaryLine } from "@/server/voice/elevenlabs";

describe("spoken shopping summary (ElevenLabs), built from counts only", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("says the numbers and that nothing is paid before pickup, in English and Spanish", () => {
    expect(summaryLine(10, 1, 2, 7, "en")).toBe("I found 10 listings. 1 blocked, 2 need a check, and 7 passed the photo check. Nothing is paid until the label passes at pickup.");
    expect(summaryLine(10, 1, 2, 7, "es")).toMatch(/^Encontré 10 anuncios/);
    expect(summaryLine(3, 0, 0, 3, "en")).not.toMatch(/\bsafe\b/i);
  });
  it("refuses counts that are not four small integers adding up, so no text can be injected", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "k");
    for (const bad of ["10,1,2", "10,1,2,8", "1,1,0,0,0", "a,b,c,d", "99,0,0,99", "3,-1,2,2"]) {
      expect((await GET(new Request(`http://x/api/voice?summary=${bad}`))).status, bad).toBe(400);
    }
  });
});
