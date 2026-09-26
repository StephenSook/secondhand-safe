"""Listing harvest (PLAN 1.6): real public listings, normalized, with seller contact details removed.

Sources
  craigslist  Apify dataset from solidcode/craigslist-scraper (Atlanta, for-sale, nursery terms)
  ebay        Apify dataset from delicious_zebu/ebay-product-listing-scraper (US, used nursery terms)
  cpsc        CPSC recall API: product photos from recall notices (training images, public domain)

Usage
  APIFY_TOKEN=... python ml/harvest.py apify craigslist <datasetId>
  APIFY_TOKEN=... python ml/harvest.py apify ebay <datasetId>
  python ml/harvest.py cpsc

Writes ml/data/listings.jsonl and ml/data/cpsc_images.jsonl (gitignored: raw listing data never goes in
the public repo). Every row keeps its source URL so any flag can be checked by hand.
"""
import json
import os
import re
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
UA = {"User-Agent": "Mozilla/5.0 (Macintosh) SecondHandSafe-research (HackGT 13)", "Accept": "application/json"}

EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
PHONE = re.compile(r"(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)")

# CPSC ProductName searches that return photos of each banned or restricted product type.
CPSC_QUERIES = {
    "inclined_or_inbed_sleeper": [("ProductName", "Rock 'n Play"), ("ProductName", "inclined sleeper"),
                                  ("ProductName", "rocking sleeper"), ("ProductName", "in-bed sleeper"),
                                  ("ProductName", "Bedside Sleeper"), ("RecallTitle", "Inclined Sleep")],
    "crib_bumper": [("ProductName", "crib bumper"), ("RecallTitle", "Bumper")],
    "drop_side_crib": [("ProductName", "drop-side"), ("RecallTitle", "Drop-Side"), ("ProductName", "drop side crib")],
}


def redact(text):
    """Remove email addresses and phone numbers from free text."""
    if not text:
        return ""
    return PHONE.sub("[phone removed]", EMAIL.sub("[email removed]", text))


def ebay_image(url):
    """eBay search cards carry a small thumbnail; the same path at s-l500 is the listing photo."""
    if not url:
        return None
    return re.sub(r"/s-l\d+\.", "/s-l500.", url)


def _price(v):
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r"[\d,]+(?:\.\d+)?", str(v or ""))
    return float(m.group(0).replace(",", "")) if m else None


def normalize_craigslist(row):
    imgs = [u for u in (row.get("imageUrls") or []) if u]
    lat, lng = row.get("latitude"), row.get("longitude")
    return {
        "id": f"cl:{row.get('postId') or row.get('url')}",
        "source": "craigslist",
        # training can use any city; the Atlanta headline number counts region == "atlanta" only
        "region": row.get("region"),
        "url": row.get("url"),
        "title": redact(row.get("title")),
        "description": redact(row.get("description")),
        "priceUsd": _price(row.get("priceUsd")),
        "location": redact(row.get("location")),   # sellers put phone numbers here too
        # rounded to about 1 km: enough for the map, not a seller's address
        "lat": round(lat, 2) if isinstance(lat, (int, float)) else None,
        "lng": round(lng, 2) if isinstance(lng, (int, float)) else None,
        "postedAt": row.get("postedAt"),
        "images": imgs,
    }


def normalize_ebay(row):
    img = ebay_image(row.get("image_url"))
    return {
        "id": f"ebay:{row.get('item_id') or row.get('product_url')}",
        "source": "ebay",
        "url": (row.get("product_url") or "").split("?")[0] or None,
        "title": redact(row.get("product_title")),
        "description": "",
        "priceUsd": _price(row.get("price")),
        "location": redact(row.get("item_location")),
        "lat": None,
        "lng": None,
        "postedAt": None,
        "condition": row.get("condition"),
        "query": row.get("input_url"),
        "images": [img] if img else [],
    }


NORMALIZERS = {"craigslist": normalize_craigslist, "ebay": normalize_ebay}


def append_unique(path, rows):
    seen = set()
    if os.path.exists(path):
        with open(path) as fh:
            seen = {json.loads(line)["id"] for line in fh if line.strip()}
    added = 0
    with open(path, "a") as fh:
        for r in rows:
            if r["id"] in seen or not r.get("url") or not r["images"]:
                continue
            seen.add(r["id"])
            fh.write(json.dumps(r) + "\n")
            added += 1
    return added, len(seen)


def apify_items(dataset_id):
    token = os.environ.get("APIFY_TOKEN")
    if not token:
        sys.exit("APIFY_TOKEN is not set")
    items, offset = [], 0
    while True:
        r = requests.get(f"https://api.apify.com/v2/datasets/{dataset_id}/items",
                         params={"clean": 1, "offset": offset, "limit": 1000},
                         headers={"Authorization": f"Bearer {token}"}, timeout=120)
        r.raise_for_status()
        page = r.json()
        items += page
        if len(page) < 1000:
            return items
        offset += 1000


def cpsc_rows():
    out, seen = [], set()
    for cls, queries in CPSC_QUERIES.items():
        for field, q in queries:
            r = requests.get("https://www.saferproducts.gov/RestWebServices/Recall",
                             params={"format": "json", field: q}, headers=UA, timeout=120)
            r.raise_for_status()
            if not r.headers.get("content-type", "").startswith("application/json"):
                sys.exit(f"CPSC returned {r.headers.get('content-type')} for {q!r}: not JSON, refusing")
            for rec in r.json():
                for img in rec.get("Images") or []:
                    u = img.get("URL")
                    if not u or u in seen:
                        continue
                    seen.add(u)
                    out.append({"id": f"cpsc:{u}", "source": "cpsc", "recall": rec.get("RecallNumber"),
                                "recallDate": rec.get("RecallDate"), "title": rec.get("Title"),
                                "query": q, "queryClass": cls, "url": rec.get("URL"), "images": [u],
                                "caption": img.get("Caption")})
            time.sleep(2)
    return out


def main(argv):
    os.makedirs(DATA, exist_ok=True)
    if argv[:1] == ["apify"] and len(argv) == 3 and argv[1] in NORMALIZERS:
        raw = apify_items(argv[2])
        rows = [NORMALIZERS[argv[1]](x) for x in raw]
        added, total = append_unique(os.path.join(DATA, "listings.jsonl"), rows)
        print(f"{argv[1]}: {len(raw)} fetched, {added} new, {total} listings total")
        if not raw:
            sys.exit("dataset returned 0 items")
    elif argv == ["cpsc"]:
        rows = cpsc_rows()
        added, total = append_unique(os.path.join(DATA, "cpsc_images.jsonl"), rows)
        print(f"cpsc: {len(rows)} recall photos, {added} new, {total} total")
        if not rows:
            sys.exit("CPSC returned 0 photos")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
