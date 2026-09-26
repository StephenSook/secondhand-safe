// Renders docs/presentation/poster.html to poster.pdf (Letter landscape) and poster.png (preview).
import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// fileURLToPath decodes %20, so a folder name with a space resolves correctly
const dir = path.dirname(fileURLToPath(import.meta.url));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1056, height: 816 }, deviceScaleFactor: 2 });
await p.goto(pathToFileURL(path.join(dir, "poster.html")).href, { waitUntil: "networkidle" });
await p.evaluate(() => document.fonts.ready);
await p.pdf({ path: path.join(dir, "poster.pdf"), width: "11in", height: "8.5in", printBackground: true });
await p.screenshot({ path: path.join(dir, "poster.png") });
const overflow = await p.evaluate(() => document.body.scrollHeight - innerHeight);
console.log("rendered; vertical overflow px:", overflow);
await b.close();
