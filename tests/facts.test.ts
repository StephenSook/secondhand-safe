import { describe, it, expect } from "vitest";
import fs from "node:fs";
import facts from "../docs/FACTS.json";

/** PLAN 3.4: every number the README states must equal docs/FACTS.json (never typed from memory). */
const readme = fs.readFileSync("README.md", "utf8");
const row = (label: string) => readme.split("\n").find((l) => l.startsWith(`| ${label}`)) ?? "";

describe("README numbers come from FACTS.json", () => {
  it("recall index", () => {
    expect(row("CPSC recalls fetched")).toContain(`${facts.recallIndex.recallsFetched} / ${facts.recallIndex.nurseryRecalls}`);
  });
  it("NHTSA child seats", () => {
    expect(row("NHTSA child car seat recall campaigns")).toContain(String(facts.recallIndex.nhtsaChildSeatCampaigns));
  });
  it("identifiers on file", () => {
    expect(row("Nursery recalls with a model, batch or UPC")).toContain(String(facts.recallIndex.withAnyIdentifier));
  });
  it("listings scanned", () => {
    expect(row("Real marketplace listings scanned")).toContain(String(facts.scanned));
  });
  it("classifier", () => {
    const c = facts.classifier;
    expect(row("Banned-type model")).toContain(`${c.macroF1} (${c.macroF1Ci95[0]} to ${c.macroF1Ci95[1]})`);
    expect(row("Off-the-shelf CLIP")).toContain(String(c.zeroShotMacroF1));
    expect(row("Ordinary items wrongly flagged")).toContain(`${c.falseAlarmsOnOrdinary} vs ${c.falseAlarmsZeroShot} (of ${c.ordinaryHeldOut})`);
  });
  it("scan rounds", () => {
    const r = facts.scanRounds;
    expect(row("Listing scan flags")).toContain(`${r[0].flags} then ${r[r.length - 1].flags}`);
    expect(readme).toContain(`(${r[0].confirmed} in round 1)`);
  });
});
