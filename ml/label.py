"""Build ml/labels.csv from ml/review_decisions.csv.

review_decisions.csv holds one row per image a reviewer looked at on a contact sheet:
(pool, url, label) where label is one of the 4 classes or "drop" (not a product photo, or unclear).
Only decided images get a label: a pool image nobody reviewed is never auto-labeled. An image given two
different classes in two pools is dropped, never guessed.

  python ml/label.py
"""
import csv
import collections
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CLASSES = ["inclined_or_inbed_sleeper", "crib_bumper", "drop_side_crib", "other"]


def main():
    votes = collections.defaultdict(set)
    for r in csv.DictReader(open(os.path.join(HERE, "review_decisions.csv"))):
        if r["label"] not in CLASSES + ["drop"]:
            sys.exit(f"bad label {r['label']!r} for {r['url']}")
        votes[r["url"]].add(r["label"])
    meta = {}
    for name in ("listings.jsonl", "cpsc_images.jsonl"):
        for line in open(os.path.join(HERE, "data", name)):
            row = json.loads(line)
            meta[row["images"][0]] = row
    out, conflicts, dropped = [], 0, 0
    for u, cs in votes.items():
        cs = cs - {"drop"} if len(cs) > 1 and "drop" in cs else cs
        if len(cs) != 1:
            conflicts += 1
            continue
        cls = next(iter(cs))
        if cls == "drop":
            dropped += 1
            continue
        m = meta[u]
        out.append({"url": u, "label": cls, "source": m["source"], "listing_id": m["id"],
                    "title": (m.get("title") or "")[:120], "reviewed_by": "contact-sheet review"})
    with open(os.path.join(HERE, "labels.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["url", "label", "source", "listing_id", "title", "reviewed_by"])
        w.writeheader()
        w.writerows(sorted(out, key=lambda r: (r["label"], r["url"])))
    c = collections.Counter((r["label"], r["source"] == "cpsc") for r in out)
    print(f"{len(out)} labels ({dropped} dropped as not-a-product, {conflicts} conflicting)")
    for cls in CLASSES:
        print(f"  {cls:28s} listing photos {c[(cls, False)]:4d}   CPSC photos {c[(cls, True)]:4d}")


if __name__ == "__main__":
    main()
