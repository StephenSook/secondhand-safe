import { describe, expect, it } from "vitest";
import { WedgeBuffer, normalizeUpc } from "@/core/wedge";

/** Types `text` one key at a time starting at t0, `gap` ms apart, then Enter `gap` ms after the last key. */
function type(w: WedgeBuffer, text: string, gap: number, t0 = 1000) {
  let t = t0;
  for (const ch of text) { w.key(ch, t); t += gap; }
  return { result: w.key("Enter", t), t };
}

describe("keyboard-wedge barcode input", () => {
  it("fast digits then Enter is a scanner UPC", () => {
    const w = new WedgeBuffer();
    expect(type(w, "669028116546", 8).result).toEqual({ kind: "scan", upc: "669028116546", source: "scanner" });
  });

  it("slow typing still works on Enter, marked as typed", () => {
    const w = new WedgeBuffer();
    expect(type(w, "012345678905", 300).result).toEqual({ kind: "scan", upc: "012345678905", source: "keyboard" });
  });

  it("ignores non-digit keys (dashes, spaces, letters, Shift)", () => {
    const w = new WedgeBuffer();
    let t = 0;
    for (const k of ["0", "-", "1", " ", "2", "Shift", "a", "3", "4", "5", "6", "7", "8", "9", "0", "5"]) { w.key(k, t); t += 5; }
    expect(w.key("Enter", t)).toEqual({ kind: "scan", upc: "012345678905", source: "scanner" });
  });

  it("rejects a code that is too short, and one that is too long", () => {
    expect(type(new WedgeBuffer(), "12345", 5).result).toMatchObject({ kind: "reject", reason: expect.stringMatching(/at least 8/) });
    expect(type(new WedgeBuffer(), "1234567890123456", 5).result).toMatchObject({ kind: "reject", reason: expect.stringMatching(/at most 14/) });
  });

  it("Enter with nothing typed does nothing, and the buffer is empty after every Enter", () => {
    const w = new WedgeBuffer();
    expect(w.key("Enter", 0)).toBeNull();
    type(w, "12345", 5);
    expect(w.digits).toBe("");
    expect(type(w, "012345678905", 5).result).toMatchObject({ upc: "012345678905" });
  });

  it("a stray digit typed before a scanner burst is dropped, not glued onto the UPC", () => {
    const w = new WedgeBuffer();
    w.key("7", 0);
    expect(type(w, "669028116546", 8, 900).result).toEqual({ kind: "scan", upc: "669028116546", source: "scanner" });
  });

  it("digits older than the idle window are forgotten", () => {
    const w = new WedgeBuffer({ idleResetMs: 5000 });
    w.key("9", 0);
    w.key("9", 100);
    expect(type(w, "012345678905", 300, 20_000).result).toEqual({ kind: "scan", upc: "012345678905", source: "keyboard" });
  });

  it("Backspace removes the last digit", () => {
    const w = new WedgeBuffer();
    let t = 0;
    for (const k of ["0", "1", "2", "9", "Backspace", "3", "4", "5", "6", "7", "8", "9", "0", "5"]) { w.key(k, t); t += 400; }
    expect(w.key("Enter", t)).toMatchObject({ upc: "012345678905", source: "keyboard" });
  });

  it("a pasted value counts as typed, never as a scan", () => {
    const w = new WedgeBuffer();
    w.set("0 12345-67890 5");
    expect(w.key("Enter", 1)).toEqual({ kind: "scan", upc: "012345678905", source: "keyboard" });
  });

  it("normalizeUpc keeps digits only and checks the length", () => {
    expect(normalizeUpc("0-12345-67890-5")).toEqual({ ok: true, upc: "012345678905" });
    expect(normalizeUpc("abc").ok).toBe(false);
  });
});
