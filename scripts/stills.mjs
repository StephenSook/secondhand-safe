// Stills of judge-facing pages (PLAN 3.6). Scrolls each page so scroll-triggered sections fire, then saves
// viewport shots down the page and a full-page shot, at desktop and phone sizes.
//   node scripts/stills.mjs <baseUrl> <outDir> [path ...]
import { chromium, webkit } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const [base = "http://127.0.0.1:3107", out = "stills", ...paths] = process.argv.slice(2);
const pages = paths.length ? paths : ["/"];
fs.mkdirSync(out, { recursive: true });
const sizes = [
  { name: "desk", viewport: { width: 1440, height: 900 }, engine: chromium },
  { name: "phone", viewport: { width: 390, height: 844 }, engine: webkit, isMobile: true },
];
let count = 0;
for (const s of sizes) {
  const browser = await s.engine.launch();
  const ctx = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: 1, isMobile: s.isMobile ?? false });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  for (const p of pages) {
    const slug = p.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home";
    await page.goto(base + p, { waitUntil: "networkidle" });
    await page.waitForTimeout(3200);
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    let i = 0;
    for (let y = 0; y < h; y += Math.round(s.viewport.height * 0.8)) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(900);
      await page.screenshot({ path: path.join(out, `${s.name}-${slug}-${String(i++).padStart(2, "0")}.png`) });
      count++;
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(out, `${s.name}-${slug}-full.png`), fullPage: true });
    count++;
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    console.log(`${s.name} ${p}: ${i} shots, horizontal overflow ${overflow}px, console errors ${errors.length}`);
    for (const e of errors) console.log("   ERROR", e.slice(0, 200));
    errors.length = 0;
  }
  await browser.close();
}
if (!count) {
  console.error("no stills written");
  process.exit(1);
}
