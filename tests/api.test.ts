import { describe, it, expect } from "vitest";
import { GET as check } from "@/app/api/check/route";
import { GET as stats } from "@/app/api/stats/route";
import { GET as health } from "@/app/api/health/route";

describe("public API", () => {
  it("/api/check finds recall 26-061", async () => {
    const r = await check(new Request("http://x/api/check?model=BHC001&batch=202408"));
    const j = await r.json();
    expect(j.verdict.kind).toBe("RECALL_MATCH");
    expect(j.verdict.recall.recallNumber).toBe("26061");
  });
  it("/api/check rejects an unknown class", async () => {
    const r = await check(new Request("http://x/api/check?cls=nope&p=0.9"));
    expect(r.status).toBe(400);
  });
  it("/api/stats reports numbers from the artifacts", async () => {
    const j = await (await stats()).json();
    expect(j.recallIndex.recalls).toBeGreaterThan(1000);
    expect(j.classifier.macroF1).toBeGreaterThan(j.classifier.zeroShotMacroF1);
    expect(j.classifier.falseAlarmsOnOrdinaryItems.of).toBeGreaterThan(0);
  });
  it("/api/health never leaks values", async () => {
    process.env.GEMINI_API_KEY = "leak-check-value";
    const t = await (await health()).text();
    expect(t).not.toContain("leak-check-value");
    delete process.env.GEMINI_API_KEY;
  });
});
