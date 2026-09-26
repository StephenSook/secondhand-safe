import { describe, it, expect } from "vitest";
import { fold, checkLabel } from "@/server/recalls/match";

describe("fold", () => {
  it("folds case, punctuation and OCR look-alikes", () => {
    expect(fold("B-HC001")).toBe(fold("BHC001"));
    expect(fold("BHCOO1")).toBe(fold("BHC001"));
    expect(fold("qx 831")).toBe(fold("QX-831"));
  });
});

describe("checkLabel against the real CPSC index", () => {
  it.each(["BHC001", "B-HC001", "BHCOO1", "bhc 001"])("model %s with recalled batch hits 26-061", (model) => {
    const v = checkLabel({ model, batch: "202408" });
    expect(v.kind).toBe("RECALL_MATCH");
    expect(v.recall?.recallNumber).toBe("26061");
  });

  it("a recalled model outside the recalled batch needs a check, not a match", () => {
    const v = checkLabel({ model: "BHC001", batch: "202511" });
    expect(v.kind).toBe("NEEDS_CHECK");
    expect(v.reason).toMatch(/202408/);
  });

  it("a recalled model with an unread batch needs a check", () => {
    expect(checkLabel({ model: "BHC001" }).kind).toBe("NEEDS_CHECK");
  });

  it("a model with no batch restriction is a straight match", () => {
    const v = checkLabel({ model: "QX-831" });
    expect(v.kind).toBe("RECALL_MATCH");
    expect(v.recall?.recallNumber).toBe("26342");
  });

  it("an unknown model is NO_MATCH and never says safe", () => {
    const v = checkLabel({ model: "ZZT9Q41X" });
    expect(v.kind).toBe("NO_MATCH");
    expect(v.reason.toLowerCase()).not.toContain("safe");
    expect(v.reason).toMatch(/as of/i);
  });

  it("short tokens never match (too many collisions)", () => {
    expect(checkLabel({ model: "100" }).kind).not.toBe("RECALL_MATCH");
  });

  it.each(["4-in-1", "3-IN-1", "6-Piece", "2012", "4-Drawer"])("description token %s never matches a recall", (m) => {
    expect(checkLabel({ model: m }).kind).not.toBe("RECALL_MATCH");
  });

  it("nothing readable is UNREADABLE", () => {
    expect(checkLabel({}).kind).toBe("UNREADABLE");
  });
});

describe("legal rules (PLAN D3)", () => {
  it("crib bumper from the classifier is BANNED_TYPE", () => {
    expect(checkLabel({ cls: { cls: "crib_bumper", p: 0.9 } }).kind).toBe("BANNED_TYPE");
  });
  it("a mesh liner is excepted from the bumper ban", () => {
    expect(checkLabel({ cls: { cls: "crib_bumper", p: 0.9 }, text: "breathable mesh crib liner" }).kind).toBe("NEEDS_CHECK");
  });
  it("drop-side crib is BANNED_TYPE", () => {
    expect(checkLabel({ cls: { cls: "drop_side_crib", p: 0.8 } }).kind).toBe("BANNED_TYPE");
  });
  it("an inclined sleeper named on the label is BANNED_TYPE", () => {
    expect(checkLabel({ cls: { cls: "inclined_or_inbed_sleeper", p: 0.8 }, text: "Rock 'n Play Sleeper" }).kind).toBe("BANNED_TYPE");
  });
  it("an in-bed sleeper needs a check (bassinet standard)", () => {
    expect(checkLabel({ cls: { cls: "inclined_or_inbed_sleeper", p: 0.8 }, text: "baby nest lounger" }).kind).toBe("NEEDS_CHECK");
  });
  it("a low-confidence classifier guess never bans", () => {
    expect(checkLabel({ cls: { cls: "crib_bumper", p: 0.4 } }).kind).toBe("UNREADABLE");
  });
  it("a car seat with no recall needs the NHTSA used-seat check", () => {
    const v = checkLabel({ model: "ZZT9Q41X", text: "infant car seat" });
    expect(v.kind).toBe("NEEDS_CHECK");
    expect(v.reason).toMatch(/car seat/i);
  });
  it("a recall match outranks a banned type", () => {
    expect(checkLabel({ model: "QX-831", cls: { cls: "crib_bumper", p: 0.9 } }).kind).toBe("RECALL_MATCH");
  });
});
