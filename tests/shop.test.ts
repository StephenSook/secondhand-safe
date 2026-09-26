import { describe, it, expect } from "vitest";
import { CATALOG, prescreen, search } from "@/server/shop/catalog";
import { keywordIntent, shop } from "@/server/shop/agent";
import { POST as agentCheckout } from "@/app/api/agent/checkout/route";

describe("shopping agent catalog (real scanned listings)", () => {
  it("ships every scanned listing", () => {
    expect(CATALOG.length).toBeGreaterThan(1500);
  });
  it("keyword fallback reads a budget and a place", () => {
    const i = keywordIntent("bassinet under $80 near Midtown");
    expect(i.terms).toContain("bassinet");
    expect(i.maxPriceUsd).toBe(80);
    expect(i.atlantaOnly).toBe(true);
  });
  it("search honors the price cap and the Atlanta filter", () => {
    const r = search({ terms: ["crib"], maxPriceUsd: 60, minPriceUsd: null, atlantaOnly: true });
    expect(r.length).toBeGreaterThan(0);
    for (const l of r) {
      expect(l.region).toBe("atlanta");
      expect(l.priceUsd).toBeGreaterThan(0);
      expect(l.priceUsd).toBeLessThanOrEqual(60);
    }
  });
  it("a listing our model flags as a banned type, unreviewed, is red; a reviewed false alarm is amber, never clear", () => {
    const flagged = CATALOG.find((l) => l.cls === "drop_side_crib" && l.p >= 0.7 && !l.review);
    if (flagged) expect(prescreen(flagged).tone).toBe("red");
    const falseAlarm = CATALOG.find((l) => l.review?.ok === "no" && l.cls !== "other" && l.p >= 0.6);
    expect(falseAlarm).toBeDefined();
    expect(prescreen(falseAlarm!).tone).toBe("amber");
  });
  it("no pre-screen ever calls a listing safe", () => {
    for (const l of CATALOG) {
      const s = prescreen(l);
      // the law's own name ("Safe Sleep for Babies Act") is the only allowed use of the word
      expect(`${s.headline} ${s.reason}`.replace(/Safe Sleep for Babies Act/g, "")).not.toMatch(/\bsafe\b/i);
    }
  });
  it("uses Gemini's filters, strips a reply that calls anything safe, and falls back with a label on failure", async () => {
    const f = (async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(
      { terms: ["bassinet", "bedside sleeper"], maxPriceUsd: 80, minPriceUsd: 0, atlantaOnly: false, reply: "These are all safe picks!" }) }] } }] })) as unknown as typeof fetch;
    const r = await shop("bassinet under 80", "test-key", f);
    expect(r.engine).toBe("gemini");
    expect(r.intent.maxPriceUsd).toBe(80);
    expect(r.reply).not.toMatch(/safe/i);
    const down = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const k = await shop("bassinet under 80", "test-key", down);
    expect(k.engine).toBe("keywords");
    expect(k.reply).toMatch(/not reachable/);
  });

  it("a person's review outranks the model: confirmed is red, unsure is amber", () => {
    const yes = CATALOG.find((l) => l.review?.ok === "yes");
    expect(yes && prescreen(yes).tone).toBe("red");
    const unsure = CATALOG.find((l) => l.review?.ok === "unsure");
    expect(unsure && prescreen(unsure).tone).toBe("amber");
  });
  it("a banned-type guess below the decision threshold is amber, never 'photo check passed'", () => {
    const low = CATALOG.filter((l) => l.cls !== "other" && l.p < 0.6 && !l.review);
    expect(low.length).toBeGreaterThan(0);
    for (const l of low) expect(prescreen(l).tone).not.toBe("clear");
  });
  it("the agent checkout refuses a red listing on the server, before anything is signed", async () => {
    const red = CATALOG.find((l) => prescreen(l).tone === "red")!;
    const r = await agentCheckout(new Request("http://x/api/agent/checkout", { method: "POST", body: JSON.stringify({ listingId: red.id }) }));
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/will not buy/);
    const unknown = await agentCheckout(new Request("http://x/api/agent/checkout", { method: "POST", body: JSON.stringify({ listingId: "nope" }) }));
    expect(unknown.status).toBe(404);
  });
});
