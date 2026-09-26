import { it, expect } from "vitest";
import { shop } from "@/server/shop/agent";

/** Live Gemini intent parse (GEMINI_VERTEX="vertex:<project>:<token>"). */
it.skipIf(!process.env.GEMINI_VERTEX)("Gemini turns a spoken request into filters over real listings", async () => {
  const r = await shop("I need a bassinet for my newborn, under $80, pickup around Atlanta", process.env.GEMINI_VERTEX!);
  console.log("SHOP", r.engine, r.reply, JSON.stringify(r.intent), r.counts, r.results.map((x) => `${x.screen.tone} $${x.listing.priceUsd} ${x.listing.title.slice(0, 50)}`));
  expect(r.engine).toBe("gemini");
  expect(r.intent.maxPriceUsd).toBe(80);
  expect(r.results.length).toBeGreaterThan(0);
}, 60_000);
