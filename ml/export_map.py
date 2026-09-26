"""Export the Atlanta slice of the listing scan for /map (public/data/atlanta-scan.json).

Only fields a public listing already shows: rounded location (about 1 km), title, price, link, and what our
model saw. Review outcomes come from ml/review_rounds (the latest round wins). Nothing typed by hand.

  ml/.venv/bin/python ml/export_map.py
"""
import csv
import glob
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def main():
    rows = json.load(open(os.path.join(HERE, "out", "scan.json")))["rows"]
    review = {}
    for p in sorted(glob.glob(os.path.join(HERE, "review_rounds", "round-*.csv"))):
        for r in csv.DictReader(open(p)):
            review[r["id"]] = {"ok": r["ok"], "note": r["note"], "round": os.path.basename(p)[6:8]}
    pts = []
    for r in rows:
        if r["region"] != "atlanta" or r["lat"] is None:
            continue
        pts.append({"lat": r["lat"], "lng": r["lng"], "title": r["title"][:90], "price": r["priceUsd"], "url": r["url"],
                    "cls": r["cls"], "p": r["p"], "flagged": bool(r["bannedType"] or r["recallHits"]),
                    "review": review.get(r["id"])})
    out = {"source": "Craigslist Atlanta, harvested 2026-09-26", "count": len(pts), "points": pts}
    os.makedirs(os.path.join(ROOT, "public", "data"), exist_ok=True)
    json.dump(out, open(os.path.join(ROOT, "public", "data", "atlanta-scan.json"), "w"), separators=(",", ":"))
    print(f"{len(pts)} Atlanta points, {sum(p['flagged'] for p in pts)} flagged now, "
          f"{sum(1 for p in pts if p['review'])} ever reviewed")


if __name__ == "__main__":
    main()
