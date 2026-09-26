// Measures the deployed look-alike search (PLAN 5.2) on HELD-OUT photos: for a random sample of recalls with two
// or more CPSC photos, the index holds only photo 1; each recall's photo 2 is embedded with the same transformers.js
// q8 runtime and sent to the live MongoDB Atlas vector index. Hit@1 / hit@3 = the right recall came back first /
// in the top 3. Writes ml/out/lookalike_eval.json (tracked).
//   node scripts/eval-lookalike.mjs      (needs ml/out/emb_js_q8_recalls2.json and MONGODB_URI)
import fs from "node:fs";
import { MongoClient } from "mongodb";

const env = { ...Object.fromEntries(fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")])
  : []), ...process.env };
const second = JSON.parse(fs.readFileSync("ml/out/emb_js_q8_recalls2.json", "utf8"));
const rows = fs.readFileSync("ml/data/cpsc_recall_photos_2nd.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const client = await new MongoClient(env.MONGODB_URI, { appName: "lullabuy-eval" }).connect();
try {
  const col = client.db(env.MONGODB_DB || "lullabuy").collection("image_vectors");
  const indexed = new Set((await col.find({ kind: "recall" }, { projection: { recallNumber: 1 } }).toArray()).map((d) => d.recallNumber));
  const cases = rows.filter((r) => second[r.images[0]] && indexed.has(r.recall));
  let hit1 = 0, hit3 = 0;
  const detail = [];
  for (const r of cases) {
    const top = await col.aggregate([
      { $vectorSearch: { index: "img_vec", path: "embedding", queryVector: second[r.images[0]], numCandidates: 200, limit: 3, filter: { kind: "recall" } } },
      { $project: { _id: 0, recallNumber: 1, score: { $meta: "vectorSearchScore" } } },
    ]).toArray();
    const rank = top.findIndex((t) => t.recallNumber === r.recall) + 1;
    if (rank === 1) hit1++;
    if (rank >= 1) hit3++;
    detail.push({ recall: r.recall, rank: rank || null, top1: top[0]?.recallNumber ?? null, top1Cosine: top[0] ? Math.round((2 * top[0].score - 1) * 1000) / 1000 : null });
  }
  const out = {
    what: "Held-out retrieval: a recall's SECOND CPSC photo, searched against an index holding only each recall's first photo",
    index: "MongoDB Atlas Vector Search img_vec (cosine, 512-d CLIP ViT-B/32 transformers.js q8)",
    sampleSeed: 20260926, sampled: rows.length, evaluated: cases.length, hit1, hit3,
    hit1Rate: cases.length ? Math.round((hit1 / cases.length) * 1000) / 1000 : null,
    hit3Rate: cases.length ? Math.round((hit3 / cases.length) * 1000) / 1000 : null,
    asOf: new Date().toISOString(), detail,
  };
  fs.writeFileSync("ml/out/lookalike_eval.json", JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({ evaluated: out.evaluated, hit1, hit3, hit1Rate: out.hit1Rate, hit3Rate: out.hit3Rate }));
  if (!cases.length) process.exit(1);
} finally {
  await client.close();
}
