import { describe, expect, it } from "vitest";
import { WedgeBuffer, gtinValid, normalizeUpc } from "@/core/wedge";

/** Types `text` one key at a time starting at t0, `gap` ms apart, then Enter `gap` ms after the last key. */
function type(w: WedgeBuffer, text: string, gap: number, t0 = 1000) {
  let t = t0;
  for (const ch of text) { w.key(ch, t); t += gap; }
  return { result: w.key("Enter", t), t };
}

const RECALLED = "669028116546"; // CPSC 26530, the UPC /judge names
const CLEAN = "012345678905"; // the e2e capture UPC

describe("GTIN check digit", () => {
  it("accepts the UPCs used in /judge and the e2e, and real EAN-8 / EAN-13 / GTIN-14 codes", () => {
    for (const c of [RECALLED, CLEAN, "96385074", "4006381333931", "10012345678902", "0669028116546"]) expect(gtinValid(c)).toBe(true);
  });

  it("rejects a wrong check digit, a wrong length, and non-digits", () => {
    for (const c of ["669028116547", "7669028116546", "66902811654", "4006381333932", "abc", ""]) expect(gtinValid(c)).toBe(false);
  });
});

describe("keyboard-wedge barcode input", () => {
  it("fast digits then Enter is a scanner UPC", () => {
    const w = new WedgeBuffer();
    expect(type(w, RECALLED, 8).result).toEqual({ kind: "scan", upc: RECALLED, source: "scanner" });
  });

  it("slow typing still works on Enter, marked as typed", () => {
    const w = new WedgeBuffer();
    expect(type(w, CLEAN, 300).result).toEqual({ kind: "scan", upc: CLEAN, source: "keyboard" });
  });

  it("ignores non-digit keys (dashes, spaces, letters, Shift)", () => {
    const w = new WedgeBuffer();
    let t = 0;
    for (const k of ["0", "-", "1", " ", "2", "Shift", "a", "3", "4", "5", "6", "7", "8", "9", "0", "5"]) { w.key(k, t); t += 5; }
    expect(w.key("Enter", t)).toEqual({ kind: "scan", upc: CLEAN, source: "scanner" });
  });

  it("rejects a code that is too short, and one that is too long", () => {
    expect(type(new WedgeBuffer(), "12345", 5).result).toMatchObject({ kind: "reject", reason: expect.stringMatching(/Not a valid barcode.*5\./) });
    expect(type(new WedgeBuffer(), "1234567890123456", 5).result).toMatchObject({ kind: "reject", reason: expect.stringMatching(/Not a valid barcode/) });
  });

  it("REGRESSION: a stray 7 pressed 30 ms before a recalled scan never becomes 7669028116546", () => {
    const w = new WedgeBuffer();
    w.key("7", 0);
    const { result } = type(w, RECALLED, 8, 30);
    expect(result).toEqual({ kind: "scan", upc: RECALLED, source: "scanner", strayIgnored: "7" });
    expect(JSON.stringify(result)).not.toContain(`7${RECALLED}`);
  });

  it("a burst that fails its check digit, with no valid code inside it, is rejected (nothing sent)", () => {
    expect(type(new WedgeBuffer(), "669028116547", 8).result).toMatchObject({ kind: "reject", reason: expect.stringMatching(/fails its check digit/) });
  });

  it("a burst that reads as two valid barcodes is rejected, never guessed", () => {
    // one stray digit in front of a UPC-A can never make a valid EAN-13 (it adds itself to the checksum), but two
    // can make a valid GTIN-14: 17 + 012345678905 is valid, and so is 012345678905 on its own
    expect(gtinValid(`17${CLEAN}`)).toBe(true);
    const w = new WedgeBuffer();
    w.key("1", 0);
    w.key("7", 10);
    expect(type(w, CLEAN, 8, 20).result).toMatchObject({ kind: "reject", reason: expect.stringMatching(/more than one valid barcode/) });
  });

  it("a leading 0 is the EAN-13 form of a UPC-A, not a stray key", () => {
    expect(type(new WedgeBuffer(), `0${RECALLED}`, 8).result).toEqual({ kind: "scan", upc: `0${RECALLED}`, source: "scanner" });
  });

  it("hand typing also needs a valid check digit: a typo is rejected, never repaired", () => {
    expect(type(new WedgeBuffer(), "669028116547", 300).result).toMatchObject({ kind: "reject" });
    const w = new WedgeBuffer();
    w.key("7", 0);
    expect(type(w, RECALLED, 300, 300).result).toMatchObject({ kind: "reject" });
  });

  it("Enter with nothing typed does nothing, and the buffer is empty after every Enter", () => {
    const w = new WedgeBuffer();
    expect(w.key("Enter", 0)).toBeNull();
    type(w, "12345", 5);
    expect(w.digits).toBe("");
    expect(type(w, CLEAN, 5).result).toMatchObject({ upc: CLEAN });
  });

  it("digits typed slowly long before a scanner burst are not part of it", () => {
    const w = new WedgeBuffer();
    w.key("7", 0);
    expect(type(w, RECALLED, 8, 900).result).toEqual({ kind: "scan", upc: RECALLED, source: "scanner" });
  });

  it("digits older than the idle window are forgotten", () => {
    const w = new WedgeBuffer({ idleResetMs: 5000 });
    w.key("9", 0);
    w.key("9", 100);
    expect(type(w, CLEAN, 300, 20_000).result).toEqual({ kind: "scan", upc: CLEAN, source: "keyboard" });
  });

  it("Backspace removes the last digit", () => {
    const w = new WedgeBuffer();
    let t = 0;
    for (const k of ["0", "1", "2", "9", "Backspace", "3", "4", "5", "6", "7", "8", "9", "0", "5"]) { w.key(k, t); t += 400; }
    expect(w.key("Enter", t)).toMatchObject({ upc: CLEAN, source: "keyboard" });
  });

  it("a pasted value counts as typed, never as a scan", () => {
    const w = new WedgeBuffer();
    w.set("0 12345-67890 5");
    expect(w.key("Enter", 1)).toEqual({ kind: "scan", upc: CLEAN, source: "keyboard" });
  });

  it("normalizeUpc keeps digits only and checks the barcode", () => {
    expect(normalizeUpc("0-12345-67890-5")).toEqual({ ok: true, upc: CLEAN });
    expect(normalizeUpc("abc").ok).toBe(false);
    expect(normalizeUpc("012345678906").ok).toBe(false);
  });
});
