"""Export the scanned real listings as the shopping agent's catalog (data/shop-listings.json).

Every row is a real public eBay or Craigslist listing harvested 2026-09-26 (ml/harvest.py), with what our model
saw (ml/out/scan.json) and, where a person reviewed the flag, that review (ml/review_rounds, latest round wins).
Only fields the public listing already shows, location rounded to about 1 km. Nothing typed by hand.

  ml/.venv/bin/python ml/export_shop.py
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
            review[r["id"]] = {"ok": r["ok"], "note": r["note"][:80]}
    out = []
    for r in rows:
        if not r["title"] or not r["url"]:
            continue
        out.append({
            "id": r["id"], "source": r["source"], "region": r["region"], "url": r["url"], "image": r["image"],
            "title": r["title"][:120], "priceUsd": r["priceUsd"],
            "lat": None if r["lat"] is None else round(r["lat"], 2), "lng": None if r["lng"] is None else round(r["lng"], 2),
            "cls": r["cls"], "p": r["p"], "review": review.get(r["id"]),
        })
    doc = {"source": "Real eBay and Craigslist listings harvested 2026-09-26, scanned by our classifier", "count": len(out), "listings": out}
    json.dump(doc, open(os.path.join(ROOT, "data", "shop-listings.json"), "w"), separators=(",", ":"))
    print(f"{len(out)} listings, {sum(1 for x in out if x['review'])} with a human review")


if __name__ == "__main__":
    main()
