"""Train the banned-product head on CLIP (and DINOv2) embeddings. PLAN 1.7.

Split rule (fixed before any training, seed 13):
  groups    = one group per CPSC recall number, one group per marketplace listing
  held-out  = about 35% of each class's groups (at least 8 images); no recall and no listing is ever on
              both sides, so held-out measures products the head has never seen
  leakage   = any train image with cosine >= 0.97 to a held-out image is removed from train
              (sellers and recall notices reuse the same product photos)
  why not "listing photos only": banned products are rare on the marketplaces (eBay removes most of them),
  so the banned classes have fewer than 10 listing photos each; every one of those is held out.

Writes ml/out/split.json, ml/out/head_clip.joblib, ml/out/head_dino.joblib and public/models/head.json
(the CLIP head the Node runtime applies).

  python ml/train.py
"""
import csv
import json
import os
import random
import sys

import joblib
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GridSearchCV, StratifiedKFold

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
CLASSES = ["inclined_or_inbed_sleeper", "crib_bumper", "drop_side_crib", "other"]
HELD_FRAC, HELD_MIN, DUP = 0.35, 8, 0.97


# The shipped head is trained on embeddings from the SAME runtime the phone runs (transformers.js, q8,
# scripts/embed-js.mjs). Python CLIP resizes images slightly differently, which moved logits by up to 0.5.
SHIPPED_CLIP = os.path.join(OUT, "emb_js_q8.json")


def load_emb(name):
    if name == "clip" and os.path.exists(SHIPPED_CLIP):
        # transformers.js image_embeds are NOT unit length; normalize so cosine thresholds mean what they say
        out = {}
        raw = json.load(open(SHIPPED_CLIP))
        listings = SHIPPED_CLIP.replace(".json", "_listings.json")
        if os.path.exists(listings):
            raw = {**json.load(open(listings)), **raw}
        for u, v in raw.items():
            a = np.asarray(v, dtype=np.float32)
            out[u] = a / (np.linalg.norm(a) or 1.0)
        return out
    d = np.load(os.path.join(OUT, f"emb_{name}.npz"))
    return {u: e for u, e in zip(d["urls"], d["emb"])}


def clip_source():
    return "transformers.js q8 (shipped runtime)" if os.path.exists(SHIPPED_CLIP) else "python transformers fp32"


def group_of(r, meta):
    m = meta.get(r["url"], {})
    return f"recall:{m.get('recall')}" if r["source"] == "cpsc" else f"listing:{r['listing_id']}"


def make_split(labels, emb):
    meta = {}
    for name in ("listings.jsonl", "cpsc_images.jsonl"):
        for line in open(os.path.join(HERE, "data", name)):
            row = json.loads(line)
            meta[row["images"][0]] = row
    rng = random.Random(13)
    held, train = [], []
    # Hard negatives mined from the listing scan are training data only; excluding them here keeps the held-out
    # selection identical to the split before they existed.
    extra = [r for r in labels if r.get("reviewed_by", "").startswith("scan review")]
    labels = [r for r in labels if r not in extra]
    train += extra
    for cls in CLASSES:
        rows = [r for r in labels if r["label"] == cls]
        groups = {}
        for r in rows:
            groups.setdefault(group_of(r, meta), []).append(r)
        # marketplace listings go to held-out first (they are the real-world case), then recall groups
        keys = sorted(groups)
        rng.shuffle(keys)
        keys.sort(key=lambda k: not k.startswith("listing:"))
        target = max(HELD_MIN, round(HELD_FRAC * len(rows)))
        h = []
        for k in keys:
            if len(h) >= target:
                break
            h += groups[k]
        if len(rows) - len(h) < 5:
            sys.exit(f"{cls}: {len(rows)} labeled images is too few to train and hold out")
        held += h
        train += [r for r in rows if r not in h]
    H = np.stack([emb[r["url"]] for r in held])
    keep, dropped = [], 0
    for r in train:
        if float((H @ emb[r["url"]]).max()) >= DUP:
            dropped += 1
        else:
            keep.append(r)
    return keep, held, dropped


def fit(X, y):
    cv = StratifiedKFold(5, shuffle=True, random_state=13)
    g = GridSearchCV(LogisticRegression(max_iter=5000, class_weight="balanced"),
                     {"C": [0.3, 1, 3, 10, 30]}, scoring="f1_macro", cv=cv)
    g.fit(X, y)
    return g.best_estimator_, g.best_params_["C"], float(g.best_score_)


def main():
    labels = list(csv.DictReader(open(os.path.join(HERE, "labels.csv"))))
    clip = load_emb("clip")
    labels = [r for r in labels if r["url"] in clip]
    train, held, dropped = make_split(labels, clip)
    if len(train) < 0.4 * len(labels):
        sys.exit(f"only {len(train)} of {len(labels)} images left to train on ({dropped} dropped as near-duplicates); "
                 "check that embeddings are normalized")
    meta = {}
    for name in ("listings.jsonl", "cpsc_images.jsonl"):
        for line in open(os.path.join(HERE, "data", name)):
            row = json.loads(line)
            meta[row["images"][0]] = row
    # groups are stored with the split so CI can check "no product on both sides" without the raw data
    split = {"rule": __doc__.split("Split rule")[1].split("Writes")[0].strip(), "train": [r["url"] for r in train],
             "held_out": [r["url"] for r in held], "train_dropped_as_near_duplicates": dropped,
             "group": {r["url"]: group_of(r, meta) for r in train + held}}
    json.dump(split, open(os.path.join(OUT, "split.json"), "w"), indent=1)
    y = np.array([CLASSES.index(r["label"]) for r in train])
    info = {}
    for name in ("clip", "dino"):
        path = os.path.join(OUT, f"emb_{name}.npz")
        if not os.path.exists(path):
            continue
        emb = clip if name == "clip" else load_emb(name)
        if not all(r["url"] in emb for r in train + held):
            sys.exit(f"{name} embeddings are missing split images; re-run embed.py")
        X = np.stack([emb[r["url"]] for r in train])
        model, C, cvf1 = fit(X, y)
        joblib.dump(model, os.path.join(OUT, f"head_{name}.joblib"))
        info[name] = {"C": C, "train_cv_macro_f1": round(cvf1, 4),
                      "embeddings": clip_source() if name == "clip" else "python transformers fp32 (DINOv2)"}
        print(f"{name}: C={C} 5-fold train macro-F1 {cvf1:.3f}")
        if name == "clip":
            os.makedirs(os.path.join(HERE, "..", "public", "models"), exist_ok=True)
            json.dump({"model": "Xenova/clip-vit-base-patch32", "embeddings": clip_source(),
                       "input": "L2-normalized image embedding [512]", "classes": CLASSES,
                       "coef": np.round(model.coef_, 7).tolist(), "intercept": np.round(model.intercept_, 7).tolist()},
                      open(os.path.join(HERE, "..", "public", "models", "head.json"), "w"))
    json.dump(info, open(os.path.join(OUT, "train_info.json"), "w"), indent=1)
    print(f"train {len(train)} ({dropped} near-duplicates of held-out removed), held-out {len(held)}")


if __name__ == "__main__":
    main()
