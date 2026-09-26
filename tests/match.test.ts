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

describe("NHTSA child seats (real campaign 26C001000, Evenflo Titan 65, made 03/2025 to 12/2025)", () => {
  it("a recalled seat model without a readable date needs the date", () => {
    const v = checkLabel({ model: "3712198" });
    expect(v.kind).toBe("NEEDS_CHECK");
    expect(v.recall?.recallNumber).toBe("26C001000");
    expect(v.reason).toMatch(/03\/2025 to 12\/2025/);
  });
  it("inside the recalled date range is a recall match", () => {
    expect(checkLabel({ model: "3712198", date: "07/15/2025" }).kind).toBe("RECALL_MATCH");
    expect(checkLabel({ model: "3712198", date: "AUG 2025" }).kind).toBe("RECALL_MATCH");
  });
  it("outside the range still needs the used-seat check, never a clean pass", () => {
    const v = checkLabel({ model: "3712198", date: "2024-01-10" });
    expect(v.kind).toBe("NEEDS_CHECK");
    expect(v.reason).toMatch(/outside/);
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

describe("short all-digit model numbers never move money on their own (real Delta drop-side crib recalls list 4340)", () => {
  it("4340 with no brand waits for a person and names the brand", () => {
    const v = checkLabel({ model: "4340" });
    expect(v.kind).toBe("NEEDS_CHECK");
    expect(v.reason).toMatch(/Delta/);
    expect(v.reason).toMatch(/confirm the brand/);
  });
  it("brand words in ordinary listing text do not turn a short number into a reversal", () => {
    for (const [model, text] of [["2158", "pickup at my place"], ["02800", "used one summer"], ["8050", "love the simplicity"],
      ["700452", "small gap in seam"], ["4340", "Delta Enterprise crib"]]) {
      expect(checkLabel({ model, text }).kind, `${model} / ${text}`).toBe("NEEDS_CHECK");
    }
  });
  it("an uncertain recall hit never hides a banned type (Delta 4340 photographed as a drop-side crib)", () => {
    expect(checkLabel({ model: "4340", cls: { cls: "drop_side_crib", p: 0.9 } }).kind).toBe("BANNED_TYPE");
  });
  it("an OCR letter O inside a number is still a short number (O2800)", () => {
    expect(checkLabel({ model: "O2800" }).reason).toMatch(/confirm the brand/);
  });
  it("letter models that fold to digits are still letter models (Deux par Deux L524, CPSC 10194)", () => {
    expect(checkLabel({ model: "L524" }).kind).toBe("RECALL_MATCH");
  });
  it("alphanumeric model numbers still match directly (BHC001 batch 202408)", () => {
    expect(checkLabel({ model: "BHC001", batch: "202408" }).kind).toBe("RECALL_MATCH");
  });
});

describe("UPC matching is by GTIN, whatever the zero padding a scanner sends", () => {
  it("a recalled UPC-A matches as scanned, as its EAN-13 (0 + UPC-A) and as its GTIN-14 (00 + UPC-A)", () => {
    for (const upc of ["669028116546", "0669028116546", "00669028116546"]) {
      expect(checkLabel({ upc }).kind, upc).toBe("RECALL_MATCH");
      expect(checkLabel({ upc }).recall?.recallNumber).toBe("26530");
    }
  });
  it("an 11-digit recall UPC never moves money: either reading of it keeps the hold (recall 11220, 80640907402)", () => {
    // 080640907402 (zero missing in front) and 806409074020 (check digit missing) are two different valid UPC-As
    for (const upc of ["080640907402", "806409074020"]) {
      const v = checkLabel({ upc });
      expect(v.kind, upc).toBe("NEEDS_CHECK");
      expect(v.recall?.recallNumber).toBe("11220");
      expect(v.reason).toMatch(/printed without one digit/);
    }
    expect(checkLabel({ upc: "066264914743" }).kind).toBe("NEEDS_CHECK"); // CPSC 12017 lists 06626491474
  });
  it("REGRESSION: a UPC with a wrong check digit is never an identifier (066264914740, a corrupted 066264914743)", () => {
    const alone = checkLabel({ upc: "066264914740" });
    expect(alone.kind).toBe("UNREADABLE");
    expect(alone.reason).toMatch(/not a valid barcode/);
    const withModel = checkLabel({ upc: "066264914740", model: "ZZT9Q41X" });
    expect(withModel.kind).toBe("NO_MATCH"); // decided on the model, and it says the UPC was not used
    expect(withModel.reason).toMatch(/UPC 066264914740 is not a valid barcode/);
    expect(checkLabel({ upc: "066264914740", model: "BHC001", batch: "202408" }).kind).toBe("RECALL_MATCH");
  });
  it("a clean UPC with no recall is NO_MATCH (the e2e capture UPC)", () => {
    expect(checkLabel({ upc: "012345678905" }).kind).toBe("NO_MATCH");
  });
});

describe("CPSC API titles that belong to a different recall (data/handcheck.md, 2026-09-26)", () => {
  it("the Joolz car seat adapters match 26568 by their real identifier NL311", () => {
    const v = checkLabel({ model: "NL311" });
    expect(v.kind).toBe("RECALL_MATCH");
    expect(v.recall?.recallNumber).toBe("26568");
  });

  it("Aer2 (a stroller the notice says is NOT recalled, from 26568's title) never matches 26569", () => {
    const v = checkLabel({ model: "Aer2" });
    expect(v.recall?.recallNumber).not.toBe("26569");
    expect(v.kind).not.toBe("RECALL_MATCH");
  });

  it("every CPSC record's title agrees with its own recall page URL", async () => {
    const recalls: { source: string; recallNumber: string; title: string; url: string }[] =
      (await import("../data/recalls.json")).default;
    const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []));
    const bad = recalls.filter((r) => {
      if (r.source !== "CPSC") return false;
      const slug = r.url.replace(/\/$/, "").split("/").pop() ?? "";
      if ((slug.match(/-/g) ?? []).length < 4) return false; // old-style URLs carry no title
      const s = words(slug.replace(/-/g, " "));
      return !(r.title.match(/[A-Za-z0-9]{4,}/g) ?? []).slice(0, 4).some((w) => s.has(w.toLowerCase()));
    });
    expect(bad.map((r) => r.recallNumber)).toEqual([]);
    expect(recalls.filter((r) => r.source === "CPSC").length).toBeGreaterThan(1000);
  });
});
