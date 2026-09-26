"""Evaluate on the held-out listing photos and write ml/out/metrics.json (the map page reads it).

Systems compared on the same held-out set:
  zero_shot   CLIP zero-shot prompts (embed.PROMPTS), no training
  clip_head   our logistic-regression head on CLIP embeddings (the one that ships)
  dino_head   the same head on DINOv2 embeddings (comparison only)

Macro-F1 carries a 2,000-sample bootstrap 95% interval, because a held-out set this size is small.

  python ml/eval.py
"""
import csv
import datetime
import json
import os

import joblib
import numpy as np
from sklearn.metrics import confusion_matrix, f1_score, precision_recall_fscore_support

from train import CLASSES, OUT, HERE, load_emb


def boot_ci(y, p, n=2000):
    rng = np.random.default_rng(13)
    vals = []
    for _ in range(n):
        i = rng.integers(0, len(y), len(y))
        vals.append(f1_score(y[i], p[i], average="macro", labels=range(len(CLASSES)), zero_division=0))
    return [round(float(np.percentile(vals, 2.5)), 4), round(float(np.percentile(vals, 97.5)), 4)]


def report(y, p):
    pr, rc, f1, sup = precision_recall_fscore_support(y, p, labels=range(len(CLASSES)), zero_division=0)
    return {"macro_f1": round(float(f1_score(y, p, average="macro", labels=range(len(CLASSES)), zero_division=0)), 4),
            "macro_f1_ci95": boot_ci(y, p),
            "accuracy": round(float((y == p).mean()), 4),
            "per_class": {c: {"precision": round(float(pr[i]), 4), "recall": round(float(rc[i]), 4),
                              "f1": round(float(f1[i]), 4), "n": int(sup[i])} for i, c in enumerate(CLASSES)},
            "confusion": confusion_matrix(y, p, labels=range(len(CLASSES))).tolist()}


def main():
    for name in ("clip", "dino"):
        h = os.path.join(OUT, f"head_{name}.joblib")
        if os.path.exists(h) and os.path.getmtime(h) < os.path.getmtime(os.path.join(OUT, "split.json")):
            raise SystemExit(f"head_{name}.joblib is older than split.json: train.py did not finish; refusing to score a stale head")
    split = json.load(open(os.path.join(OUT, "split.json")))
    label = {r["url"]: r["label"] for r in csv.DictReader(open(os.path.join(HERE, "labels.csv")))}
    held = split["held_out"]
    y = np.array([CLASSES.index(label[u]) for u in held])
    d = np.load(os.path.join(OUT, "emb_clip.npz"))
    zs = {u: z for u, z in zip(d["urls"], d["zs"])}
    systems = {"zero_shot": np.array([int(np.argmax(zs[u])) for u in held])}
    for name in ("clip", "dino"):
        path = os.path.join(OUT, f"head_{name}.joblib")
        if os.path.exists(path):
            emb = load_emb(name)
            # joblib only loads the heads train.py wrote to ml/out on this machine, never downloaded files
            systems[f"{name}_head"] = joblib.load(path).predict(np.stack([emb[u] for u in held]))
    metrics = {
        "asOf": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "classes": CLASSES, "held_out_n": len(held), "train_n": len(split["train"]),
        "split_rule": split["rule"], "train_dropped_as_near_duplicates": split["train_dropped_as_near_duplicates"],
        "systems": {k: report(y, p) for k, p in systems.items()},
        "train_info": json.load(open(os.path.join(OUT, "train_info.json"))),
    }
    json.dump(metrics, open(os.path.join(OUT, "metrics.json"), "w"), indent=1)
    for k, m in metrics["systems"].items():
        print(f"{k:10s} macro-F1 {m['macro_f1']:.3f} {m['macro_f1_ci95']}  acc {m['accuracy']:.3f}")


if __name__ == "__main__":
    main()
