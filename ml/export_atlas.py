"""Embedding atlas (PLAN 3.2 /atlas): every labeled image plus every scanned listing, laid out in 2D by t-SNE over
the SAME transformers.js q8 CLIP embeddings the phone computes. Points carry the reviewed label (if any), the
model's prediction and its source link, so the page can show where banned products cluster.

  ml/.venv/bin/python ml/export_atlas.py   -> public/data/atlas.json
"""
import csv
import json
import os

import joblib
import numpy as np
from sklearn.manifold import TSNE

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CLASSES = ["inclined_or_inbed_sleeper", "crib_bumper", "drop_side_crib", "other"]


def main():
    emb = {**json.load(open(os.path.join(HERE, "out", "emb_js_q8_listings.json"))), **json.load(open(os.path.join(HERE, "out", "emb_js_q8.json")))}
    labels = {r["url"]: r for r in csv.DictReader(open(os.path.join(HERE, "labels.csv")))}
    meta = {}
    for name in ("listings.jsonl", "cpsc_images.jsonl"):
        for line in open(os.path.join(HERE, "data", name)):
            r = json.loads(line)
            meta[r["images"][0]] = r
    urls = [u for u in emb if u in meta]
    X = np.stack([np.asarray(emb[u], dtype=np.float32) for u in urls])
    X /= np.linalg.norm(X, axis=1, keepdims=True)
    head = joblib.load(os.path.join(HERE, "out", "head_clip.joblib"))  # local artifact written by train.py
    probs = head.predict_proba(X)
    xy = TSNE(n_components=2, perplexity=35, init="pca", random_state=13, metric="cosine").fit_transform(X)
    xy = (xy - xy.min(0)) / (xy.max(0) - xy.min(0))
    pts = []
    for u, (x, y), p in zip(urls, xy, probs):
        m, lab = meta[u], labels.get(u)
        k = int(np.argmax(p))
        pts.append({"x": round(float(x), 4), "y": round(float(y), 4), "img": u, "src": m["source"],
                    "title": (m.get("title") or "")[:90], "url": m.get("url"),
                    "label": lab["label"] if lab else None, "pred": CLASSES[k], "p": round(float(p[k]), 3)})
    out = {"method": "t-SNE (cosine, perplexity 35, seed 13) over transformers.js q8 CLIP ViT-B/32 embeddings",
           "count": len(pts), "labeled": sum(1 for p in pts if p["label"]), "points": pts}
    json.dump(out, open(os.path.join(ROOT, "public", "data", "atlas.json"), "w"), separators=(",", ":"))
    print(f"{len(pts)} points, {out['labeled']} with reviewed labels")


if __name__ == "__main__":
    main()
