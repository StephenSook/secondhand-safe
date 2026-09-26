// Embed every labeled image with the SAME runtime the app ships (transformers.js, Xenova CLIP ViT-B/32,
// q8), so the head trained on these embeddings sees exactly what the phone computes.
//   node scripts/embed-js.mjs [q8|fp32] [labels|listings] -> ml/out/emb_js_<dtype>[_listings].json {url: [512]}
import { CLIPVisionModelWithProjection, AutoProcessor, RawImage } from "@huggingface/transformers";
import crypto from "node:crypto";
import fs from "node:fs";

const dtype = process.argv[2] ?? "q8";
// "listings" mode embeds the first photo of every harvested listing (PLAN 2.9 scan); "recalls" mode embeds the
// first photo of every CPSC recall in the index (PLAN 5.2 look-alike search); default = labeled images
const mode = process.argv[3] ?? "labels";
const firstPhotos = (f) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l).images[0]);
const urls = mode === "listings" ? firstPhotos("ml/data/listings.jsonl")
  : mode === "recalls" ? firstPhotos("ml/data/cpsc_recall_photos.jsonl")
  : fs.readFileSync("ml/labels.csv", "utf8").trim().split("\n").slice(1).map((l) => l.split(",")[0]);
const imgPath = (u) => `ml/data/img/${crypto.createHash("sha1").update(u).digest("hex").slice(0, 16)}.img`;
// A recall photo the fetcher refused (WAF page, dead link) is skipped and counted, never embedded as garbage.
const skipMissing = mode === "recalls";
let skipped = 0;
const processor = await AutoProcessor.from_pretrained("Xenova/clip-vit-base-patch32");
const model = await CLIPVisionModelWithProjection.from_pretrained("Xenova/clip-vit-base-patch32", { dtype });
const out = {};
let i = 0;
for (const u of urls) {
  const p = imgPath(u);
  if (!fs.existsSync(p)) {
    if (skipMissing) { skipped++; continue; }
    throw new Error(`missing image for ${u}`);
  }
  const { image_embeds } = await model(await processor(await RawImage.read(p)));
  out[u] = Array.from(image_embeds.data, (v) => Math.round(v * 1e6) / 1e6);
  if (++i % 50 === 0) console.log(`${i}/${urls.length}`);
}
fs.writeFileSync(mode === "labels" ? `ml/out/emb_js_${dtype}.json` : `ml/out/emb_js_${dtype}_${mode}.json`, JSON.stringify(out));
console.log(`embedded ${i} images with transformers.js ${dtype}${skipped ? `, skipped ${skipped} with no downloaded photo` : ""}`);
if (i === 0) process.exit(1);
