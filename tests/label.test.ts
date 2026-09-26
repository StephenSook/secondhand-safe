import { describe, it, expect } from "vitest";
import { readLabel } from "@/server/ml/label";

/** Unit tests of the response handling with a stubbed transport. The live Gemini call is tests/label.live.test.ts. */
const reply = (obj: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(status === 200 ? { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } : { error: { message: "nope" } }), { status })) as unknown as typeof fetch;

describe("readLabel", () => {
  it("keeps only label-shaped values and derives readable from model or upc", async () => {
    const r = await readLabel("AA", "image/jpeg", "k", reply({ readable: true, model: "BHC001", batch: "202408", upc: "0 12345 67890 5",
      boxes: [{ field: "model", x: 0.1, y: 0.2, w: 1.4, h: 0.1 }, { field: "bogus", x: 0, y: 0, w: 0, h: 0 }] }));
    expect(r.readable).toBe(true);
    expect(r.model).toBe("BHC001");
    expect(r.upc).toBe("012345678905");
    expect(r.boxes).toEqual([{ field: "model", x: 0.1, y: 0.2, w: 1, h: 0.1 }]);
  });
  it("is unreadable when neither model nor UPC was read, whatever the model claims", async () => {
    const r = await readLabel("AA", "image/jpeg", "k", reply({ readable: true, brand: "Graco", boxes: [] }));
    expect(r.readable).toBe(false);
  });
  it("drops non-printable or overlong values", async () => {
    const r = await readLabel("AA", "image/jpeg", "k", reply({ readable: true, model: "x".repeat(80), boxes: [] }));
    expect(r.model).toBeUndefined();
    expect(r.readable).toBe(false);
  });
  it("surfaces a Gemini error instead of guessing", async () => {
    await expect(readLabel("AA", "image/jpeg", "k", reply({}, 402))).rejects.toThrow(/402/);
  });
});
