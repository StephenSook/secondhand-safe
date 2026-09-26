import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readLabel } from "@/server/ml/label";
import { checkLabel } from "@/server/recalls/match";

/**
 * Live: Gemini reads a real label photo from CPSC recall 11020 (Heritage drop-side crib, label shows model
 * 07-1248). Needs GEMINI_API_KEY, or GEMINI_VERTEX="vertex:<project>:<token>". `npm run test:live`.
 */
const key = process.env.GEMINI_VERTEX || process.env.GEMINI_API_KEY;
describe.skipIf(!key)("label reader, live", () => {
  it("reads the model number off a real recalled crib label, and the check matches the recall", async () => {
    const b64 = fs.readFileSync(path.join(__dirname, "fixtures", "label-heritage-crib.jpg")).toString("base64");
    const r = await readLabel(b64, "image/jpeg", key!);
    console.log("label read", JSON.stringify({ ...r, boxes: r.boxes.length }));
    expect(r.readable).toBe(true);
    expect(r.model?.replace(/\s/g, "")).toMatch(/07-?1248/);
    const v = checkLabel({ model: r.model, batch: r.batch, date: r.date, upc: r.upc });
    console.log("verdict", v.kind, v.recall?.recallNumber);
    expect(["RECALL_MATCH", "NEEDS_CHECK"]).toContain(v.kind);
    expect(v.recall?.recallNumber).toBe("11020");
  }, 120_000);
});
