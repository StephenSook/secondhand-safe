// Load CLIP photo embeddings into MongoDB Atlas and build the vector index (PLAN 5.2). Idempotent: re-running
// replaces the same documents and reuses the index.
//   node scripts/seed-vectors.mjs            (reads MONGODB_URI and MONGODB_DB from .env.local or the env)
// Inputs (all produced by scripts/embed-js.mjs with the SAME q8 runtime the phone uses):
//   ml/out/emb_js_q8_recalls.json + ml/data/cpsc_recall_photos.jsonl   -> kind "recall"
//   ml/out/emb_js_q8_listings.json + data/shop-listings.json           -> kind "listing"
import fs from "node:fs";
import { MongoClient } from "mongodb";

const env = { ...Object.fromEntries(fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")])
  : []), ...process.env };
if (!env.MONGODB_URI) { console.error("MONGODB_URI missing"); process.exit(1); }

const COLL = "image_vectors", INDEX = "img_vec", DIMS = 512;
const readJsonl = (f) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ok = (v) => Array.isArray(v) && v.length === DIMS && v.every(Number.isFinite);

const docs = [];
const recallEmb = JSON.parse(fs.readFileSync("ml/out/emb_js_q8_recalls.json", "utf8"));
// titles come from the recall index, where CPSC API titles that belong to a different recall are corrected
const indexTitle = new Map(JSON.parse(fs.readFileSync("data/recalls.json", "utf8")).map((x) => [x.recallNumber, x.title]));
for (const r of readJsonl("ml/data/cpsc_recall_photos.jsonl")) {
  const e = recallEmb[r.images[0]];
  if (!ok(e)) continue;
  docs.push({ _id: `recall:${r.recall}`, kind: "recall", recallNumber: r.recall, title: indexTitle.get(r.recall) ?? r.title, productType: r.productType ?? null,
    recallDate: (r.recallDate ?? "").slice(0, 10) || null, notice: r.url, image: r.images[0], embedding: e });
}
const nRecall = docs.length;
const listingEmb = JSON.parse(fs.readFileSync("ml/out/emb_js_q8_listings.json", "utf8"));
for (const l of JSON.parse(fs.readFileSync("data/shop-listings.json", "utf8")).listings) {
  const e = l.image && listingEmb[l.image];
  if (!ok(e)) continue;
  docs.push({ _id: `listing:${l.id}`, kind: "listing", listingId: l.id, title: l.title, image: l.image, url: l.url, embedding: e });
}
console.log(`documents: ${nRecall} recall photos, ${docs.length - nRecall} listing photos`);
if (nRecall < 100) { console.error("fewer than 100 recall photos embedded; refusing to seed a near-empty index"); process.exit(1); }

const client = await new MongoClient(env.MONGODB_URI, { appName: "lullabuy-seed" }).connect();
try {
  const col = client.db(env.MONGODB_DB || "lullabuy").collection(COLL);
  for (let i = 0; i < docs.length; i += 200) {
    const batch = docs.slice(i, i + 200);
    await col.bulkWrite(batch.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })), { ordered: false });
  }
  const stale = await col.deleteMany({ _id: { $nin: docs.map((d) => d._id) } });
  console.log(`upserted ${docs.length}, removed ${stale.deletedCount} stale; collection now ${await col.countDocuments()}`);

  const definition = { fields: [{ type: "vector", path: "embedding", numDimensions: DIMS, similarity: "cosine" }, { type: "filter", path: "kind" }] };
  const existing = (await col.listSearchIndexes().toArray()).find((x) => x.name === INDEX);
  if (!existing) {
    await col.createSearchIndex({ name: INDEX, type: "vectorSearch", definition });
    console.log(`created search index ${INDEX}`);
  } else {
    console.log(`search index ${INDEX} exists (status ${existing.status})`);
  }
  for (let t = 0; t < 60; t++) {
    const ix = (await col.listSearchIndexes(INDEX).toArray())[0];
    if (ix?.queryable) { console.log(`index ${INDEX} queryable (status ${ix.status})`); break; }
    if (ix?.status === "FAILED") { console.error("index build FAILED", ix); process.exit(1); }
    if (t === 59) { console.error("index not queryable after 5 minutes"); process.exit(1); }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  // prove the index answers: a recall photo's own embedding must find itself first
  const probe = docs[0];
  const top = await col.aggregate([
    { $vectorSearch: { index: INDEX, path: "embedding", queryVector: probe.embedding, numCandidates: 100, limit: 1, filter: { kind: "recall" } } },
    { $project: { _id: 1, score: { $meta: "vectorSearchScore" } } },
  ]).toArray();
  if (top[0]?._id !== probe._id) { console.error("self-match probe failed", top); process.exit(1); }
  console.log(`self-match probe ok: ${probe._id} score ${top[0].score.toFixed(4)}`);
} finally {
  await client.close();
}
