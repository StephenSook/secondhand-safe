"""Numbered contact sheets for label review (PLAN 1.7: "CLIP pre-sort, then a human confirms each").

Each candidate pool gets sheets of 40 numbered thumbnails and an index CSV mapping sheet/cell to the image
URL. A reviewer records a decision for every cell (class or "drop") in ml/review_decisions.csv, keyed by URL;
label.py builds ml/labels.csv from those decisions only, so every label traces to a sheet someone looked
at. Sheets show only images that have no decision yet.

  python ml/review_sheets.py
"""
import csv
import json
import os
import random
import re

import numpy as np
from PIL import Image, ImageDraw

from fetch_images import image_path

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out", "sheets")
COLS, ROWS, T = 8, 5, 180

POOLS = {
    # pool name -> (class, title regex, zero-shot class that also admits an image)
    "sleeper": ("inclined_or_inbed_sleeper", r"rock\W*n\W*play|inclined|rock(?:ing|er)?\W+sleeper|in.?bed sleeper|dock.?a.?tot|snuggle\W*nest|baby nest|lounger|bedside sleeper", None),
    "bumper": ("crib_bumper", r"crib bumper|bumper pad|bumper set|bumpers", None),
    # drop-side is decided by PROVENANCE (a CPSC drop-side recall photo, or a listing whose title says drop
    # side), never by eye: a drop-side crib looks like any other crib in a photo. Review only removes
    # photos that are not the product (labels, diagrams, parts).
    "dropside": ("drop_side_crib", r"drop.?side", None),
}


def rows_by_url():
    meta = {}
    for name in ("listings.jsonl", "cpsc_images.jsonl"):
        for line in open(os.path.join(HERE, "data", name)):
            r = json.loads(line)
            meta[r["images"][0]] = r
    return meta


def pools():
    d = np.load(os.path.join(HERE, "out", "emb_clip.npz"))
    urls, zs, classes = list(d["urls"]), d["zs"], list(d["classes"])
    meta = rows_by_url()
    out = {k: [] for k in POOLS}
    for u, z in zip(urls, zs):
        r = meta[u]
        # listings match on their own title only (never on the search query that found them)
        t = r.get("title") or ""
        top = classes[int(np.argmax(z))]
        for name, (cls, pat, zs_cls) in POOLS.items():
            if re.search(pat, t, re.I) or r.get("queryClass") == cls or (zs_cls and top == zs_cls and r["source"] != "cpsc"):
                out[name].append(u)
    # "other": listings whose title matches no banned pattern, sampled across both marketplaces
    banned = "|".join(p for _, p, _ in POOLS.values()) + r"|bumper|sleeper|drop"
    other = [u for u in urls if meta[u]["source"] != "cpsc" and not re.search(banned, meta[u].get("title") or "", re.I)]
    random.Random(13).shuffle(other)
    out["other"] = other[:200]
    return out, meta


def sheet(name, urls):
    os.makedirs(OUT, exist_ok=True)
    per = COLS * ROWS
    rows = []
    for s in range(0, len(urls), per):
        im = Image.new("RGB", (COLS * T, ROWS * T), "white")
        dr = ImageDraw.Draw(im)
        for i, u in enumerate(urls[s:s + per]):
            try:
                th = Image.open(image_path(u)).convert("RGB")
                th.thumbnail((T - 4, T - 22))
            except Exception:
                continue
            x, y = (i % COLS) * T, (i // COLS) * T
            im.paste(th, (x + 2, y + 20))
            dr.rectangle([x, y, x + 34, y + 18], fill="black")
            dr.text((x + 4, y + 3), str(i), fill="yellow")
            rows.append({"pool": name, "sheet": s // per, "cell": i, "url": u})
        im.save(os.path.join(OUT, f"{name}_{s // per:02d}.jpg"), quality=85)
    return rows


def decided():
    p = os.path.join(HERE, "review_decisions.csv")
    return {r["url"] for r in csv.DictReader(open(p))} if os.path.exists(p) else set()


if __name__ == "__main__":
    import glob
    ps, _ = pools()
    done = decided()
    for f in glob.glob(os.path.join(OUT, "*.jpg")):
        os.remove(f)   # sheets always reflect the current undecided set
    index = []
    for name, urls in ps.items():
        urls = [u for u in urls if u not in done]   # only images nobody has decided yet
        index += sheet(name, urls)
        print(name, len(urls), "images,", (len(urls) + 39) // 40, "sheets")
    with open(os.path.join(HERE, "out", "sheet_index.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["pool", "sheet", "cell", "url"])
        w.writeheader()
        w.writerows(index)
