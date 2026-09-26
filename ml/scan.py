"""Measured scan of every harvested listing (PLAN 2.9). Produces the headline number's raw material.

For each listing's first photo and its text:
  image  the shipped head (transformers.js q8 embeddings) -> banned type if p >= 0.6 (mesh liners excepted)
  text   model-number-shaped tokens in title + description, folded like the app (O->0, I/L->1), matched
         against the CPSC recall index identifiers (min 4 chars, must contain a digit)
Listings whose photo was used to train or evaluate the head are marked, so they can be excluded from any
claim about unseen listings.

Writes ml/out/scan.json (all rows) and ml/review.csv (every flag, for hand review; the `ok` column is filled
by the reviewer: yes = the flag is right, no = false alarm).

  ml/.venv/bin/python ml/scan.py
"""
import csv
import json
import os
import re

import joblib
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CLASSES = ["inclined_or_inbed_sleeper", "crib_bumper", "drop_side_crib", "other"]
P_MIN = 0.6
TOKEN = re.compile(r"\b[A-Z0-9][A-Z0-9\-./]{3,}\b", re.I)


def fold(s):
    return re.sub(r"[^A-Z0-9]", "", s.upper()).replace("O", "0").replace("I", "1").replace("L", "1")


def main():
    recalls = json.load(open(os.path.join(ROOT, "data", "recalls.json")))
    by_model = {}
    for r in recalls:
        for i in r["identifiers"]:
            if i["kind"] == "model":
                k = fold(i["value"])
                if len(k) >= 4 and any(c.isdigit() for c in k):
                    by_model.setdefault(k, []).append((r["recallNumber"], i["value"], r["title"]))
    listings = [json.loads(l) for l in open(os.path.join(HERE, "data", "listings.jsonl"))]
    emb = json.load(open(os.path.join(HERE, "out", "emb_js_q8_listings.json")))
    head = joblib.load(os.path.join(HERE, "out", "head_clip.joblib"))  # local artifact written by train.py
    split = json.load(open(os.path.join(HERE, "out", "split.json")))
    used = set(split["train"]) | set(split["held_out"])
    rows, flags = [], []
    for L in listings:
        url = L["images"][0]
        e = np.asarray(emb[url], dtype=np.float64)
        e = e / (np.linalg.norm(e) or 1)
        p = head.predict_proba(e[None])[0]
        k = int(np.argmax(p))
        text = f"{L.get('title', '')} {L.get('description', '')}"
        cls = CLASSES[k] if p[k] >= P_MIN and CLASSES[k] != "other" else None
        if cls == "crib_bumper" and re.search(r"mesh", text, re.I):
            cls = None
        hits = []
        for t in TOKEN.findall(text):
            f = fold(t)
            # listing text is noisy (prices, phone fragments, years): only model-number SHAPES count,
            # letters mixed with digits, or 6+ digits ("1300" matched a parrot ad; "6929" a trailer)
            shaped = (re.search(r"[A-Z]", f) and re.search(r"\d", f)) or len(f) >= 6
            if len(f) >= 4 and shaped and f in by_model:
                hits += [{"token": t, "recall": rn, "value": v, "title": ti} for rn, v, ti in by_model[f]]
        row = {"id": L["id"], "source": L["source"], "region": L.get("region"), "url": L["url"], "image": url,
               "title": L.get("title", "")[:140], "priceUsd": L.get("priceUsd"), "lat": L.get("lat"), "lng": L.get("lng"),
               "cls": CLASSES[k], "p": round(float(p[k]), 4), "bannedType": cls, "recallHits": hits[:3],
               "usedInTraining": url in used}
        rows.append(row)
        if cls or hits:
            flags.append(row)
    json.dump({"rows": rows}, open(os.path.join(HERE, "out", "scan.json"), "w"))
    review_path = os.path.join(HERE, "review.csv")
    # every scan round is archived before the review file is rewritten, so round-to-round claims are reproducible
    rounds = os.path.join(HERE, "review_rounds")
    os.makedirs(rounds, exist_ok=True)
    if os.path.exists(review_path):
        n = len(os.listdir(rounds)) + 1
        with open(review_path) as src, open(os.path.join(rounds, f"round-{n:02d}.csv"), "w") as dst:
            dst.write(src.read())
    prior = {}
    if os.path.exists(review_path):
        prior = {r["id"]: r for r in csv.DictReader(open(review_path))}
    with open(review_path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["id", "source", "region", "flag", "detail", "usedInTraining", "title", "url", "image", "ok", "note"])
        w.writeheader()
        for r in flags:
            flag = "RECALL_MATCH" if r["recallHits"] else "BANNED_TYPE"
            detail = (f"{r['recallHits'][0]['token']} ~ CPSC {r['recallHits'][0]['recall']}" if r["recallHits"]
                      else f"{r['bannedType']} p={r['p']}")
            old = prior.get(r["id"], {})
            w.writerow({"id": r["id"], "source": r["source"], "region": r["region"] or "", "flag": flag, "detail": detail,
                        "usedInTraining": r["usedInTraining"], "title": r["title"], "url": r["url"], "image": r["image"],
                        "ok": old.get("ok", ""), "note": old.get("note", "")})
    n = len(rows)
    atl = [r for r in rows if r["region"] == "atlanta"]
    print(f"scanned {n} listings ({len(atl)} Craigslist Atlanta); flags {len(flags)} "
          f"(recall-text {sum(1 for r in flags if r['recallHits'])}, banned-type {sum(1 for r in flags if r['bannedType'])}); "
          f"flags on listings never used in training: {sum(1 for r in flags if not r['usedInTraining'])}")


if __name__ == "__main__":
    main()
