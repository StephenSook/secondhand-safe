import { CLIPVisionModelWithProjection, AutoProcessor, RawImage } from "@huggingface/transformers";
import fs from "node:fs";
const dir = "tests/fixtures/classifier";
const py = JSON.parse(fs.readFileSync(`${dir}/python.json`, "utf8"));
const processor = await AutoProcessor.from_pretrained("Xenova/clip-vit-base-patch32");
const model = await CLIPVisionModelWithProjection.from_pretrained("Xenova/clip-vit-base-patch32", { dtype: "q8" });
const out = {};
for (const f of py.fixtures) {
  const { image_embeds } = await model(await processor(await RawImage.read(`${dir}/${f.file}`)));
  out[f.file] = Array.from(image_embeds.data);
}
fs.writeFileSync(`${dir}/js_q8_embeddings.json`, JSON.stringify(out));
console.log("ok", Object.keys(out).length);
