"""Held-out sample for the look-alike eval (PLAN 5.2): recalls with 2+ CPSC photos, seeded, so anyone can rebuild it.

The Atlas index holds each recall's FIRST photo; this writes each sampled recall's SECOND photo to
ml/data/cpsc_recall_photos_2nd.jsonl. Then: ml/fetch_images.py (download, content-checked), scripts/embed-js.mjs
q8 recalls2 (same runtime as the phone), scripts/eval-lookalike.mjs (queries the live index).

  python3 ml/sample_second_photos.py
"""
import json
import random

SEED, N = 20260926, 150


def main():
    recalls = json.load(open("data/recalls.json"))
    multi = [x for x in recalls if len([u for u in (x.get("images") or []) if u.startswith("https://")]) >= 2]
    random.seed(SEED)
    pick = random.sample(multi, min(N, len(multi)))
    with open("ml/data/cpsc_recall_photos_2nd.jsonl", "w") as f:
        for x in pick:
            imgs = [u for u in x["images"] if u.startswith("https://")]
            f.write(json.dumps({"id": "recall2:" + x["recallNumber"], "recall": x["recallNumber"], "images": [imgs[1]]}) + "\n")
    print(f"recalls with 2+ photos: {len(multi)}; sampled {len(pick)} with seed {SEED}")


if __name__ == "__main__":
    main()
