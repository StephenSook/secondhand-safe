"""Build the recall index (PLAN 1.2) from the CPSC recall API.

Steps
  1. Fetch every CPSC recall 2008-today, one year per request, cached in ml/data/cpsc_raw/ (gitignored).
  2. Keep nursery and children's products (keyword match on title, product names and description).
  3. Extract model numbers, batch codes and UPCs two ways:
       regex   deterministic patterns ("Model BHC001", "model numbers 123, 456", "UPC 0 12345 67890 1")
       gemini  structured extraction with gemini-3.8-flash for the phrasings a regex misses
     A Gemini value is KEPT ONLY IF it appears verbatim (case and spacing folded) in the recall text, so the
     model can find numbers but can never invent one. Every value records how it was found.
  4. Write data/recalls.json (the index the app and Atlas load) and data/recall_stats.json.

  GEMINI_API_KEY=... ml/.venv/bin/python data/build_recall_index.py [--no-gemini]
"""
import concurrent.futures as cf
import datetime
import json
import os
import re
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "ml", "data", "cpsc_raw")
OUT = os.path.join(ROOT, "data")
UA = {"User-Agent": "Mozilla/5.0 (Macintosh) SecondHandSafe-research (HackGT 13)", "Accept": "application/json"}
MODEL = "gemini-3.8-flash"

NURSERY = re.compile(
    r"\b(crib|cribs|bassinet|bassinets|infant|infants|baby|babies|toddler|toddlers|nursery|sleeper|sleepers|"
    r"play ?yard|playpen|high ?chair|stroller|strollers|car seat|booster seat|bouncer|bouncers|swing|swings|"
    r"rocker|lounger|loungers|bumper|bumpers|changing table|baby gate|walker|jumper|carrier|carriers|"
    r"teether|pacifier|bottle|children's|child's|kids'?)\b", re.I)

MODEL_RX = [
    re.compile(r"\b(?:model|style|item|sku|part)\s*(?:numbers?|nos?\.?|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-./]{2,}(?:(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or|&)\s+)[A-Z0-9][A-Z0-9\-./]{2,})*)", re.I),
]
BATCH_RX = re.compile(r"\b(?:production\s+)?(?:batch|lot|date)\s*(?:codes?|numbers?|nos?\.?)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/]{3,}(?:(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or|&)\s+)[A-Z0-9][A-Z0-9\-/]{3,})*)", re.I)
UPC_RX = re.compile(r"\bUPC\s*(?:codes?|numbers?)?\s*[:#]?\s*((?:\d[\d\s-]{10,16}\d(?:\s*(?:,|and)\s*)?)+)", re.I)
TOKEN = re.compile(r"[A-Z0-9][A-Z0-9\-./]{2,}", re.I)
STOP = {"AND", "THE", "WITH", "FROM", "THAT", "THIS", "THROUGH", "NUMBER", "NUMBERS", "MODEL", "MODELS", "ITEM",
        "ARE", "WERE", "INCLUDED", "PRINTED", "LOCATED", "LABEL", "ONLY", "FOLLOWING", "BELOW", "RECALL"}


# Shapes that look like identifiers but are descriptions: "4-in-1", "6-piece", "4-drawer", "36-inch", years.
JUNK = re.compile(r"^(?:(?:19|20)\d\d|\d{1,3}|\d+-?(?:in-?1|in-?one|pieces?|pc|pack|drawers?|seats?|ft|in|inch(?:es)?|lbs?|oz|mm|cm|months?|mos?|years?|yrs?|ct|count))$", re.I)


def ok_id(t):
    return len(t) >= 3 and any(c.isdigit() for c in t) and t.upper() not in STOP and not JUNK.match(t)


def fold(s):
    return re.sub(r"[\s\-./]", "", s.upper())


def fetch_year(y):
    path = os.path.join(RAW, f"{y}.json")
    if os.path.exists(path):
        return json.load(open(path))
    r = requests.get("https://www.saferproducts.gov/RestWebServices/Recall",
                     params={"format": "json", "RecallDateStart": f"{y}-01-01", "RecallDateEnd": f"{y}-12-31"},
                     headers=UA, timeout=180)
    r.raise_for_status()
    if not r.headers.get("content-type", "").startswith("application/json"):
        sys.exit(f"CPSC {y}: not JSON ({r.headers.get('content-type')}), refusing")
    d = r.json()
    json.dump(d, open(path, "w"))
    time.sleep(2)
    return d


def text_of(rec):
    parts = [rec.get("Title") or "", rec.get("Description") or ""]
    parts += [p.get("Name") or "" for p in rec.get("Products") or []]
    return "\n".join(parts)


def is_nursery(rec):
    """Nursery/children's product by its TITLE and PRODUCT NAMES. The description is not used: it matches
    'keep away from children' and 'child-resistant packaging' on drugs, fuels and cleaners."""
    head = (rec.get("Title") or "") + " " + " ".join(p.get("Name") or "" for p in rec.get("Products") or [])
    if re.search(r"child.resistant|poison prevention packaging", head, re.I):
        return False
    return bool(NURSERY.search(head))


def regex_extract(text):
    models, batches, upcs = set(), set(), set()
    for rx in MODEL_RX:
        for m in rx.finditer(text):
            for t in TOKEN.findall(m.group(1)):
                for part in t.split("/"):   # "71591/71844" lists two model numbers
                    part = part.strip(".,")
                    if ok_id(part):
                        models.add(part)
    for m in BATCH_RX.finditer(text):
        for t in TOKEN.findall(m.group(1)):
            t = t.strip(".,")
            if ok_id(t):
                batches.add(t)
    for m in UPC_RX.finditer(text):
        for u in re.findall(r"\d[\d\s-]{10,16}\d", m.group(1)):
            upcs.add(re.sub(r"\D", "", u))
    return models, batches, upcs


def gemini_extract(rec, key):
    prompt = ("Extract identifiers from this U.S. CPSC recall notice. Return JSON only. "
              "models: every model number, style number, item number or SKU of the RECALLED products, exactly as "
              "written. batches: production batch codes, lot codes or date codes of recalled units, exactly as "
              "written. upcs: UPC codes as digits. brands: brand names. productType: one short noun phrase. "
              "If none, use empty lists. Never invent a value that is not in the text.\n\n" + text_of(rec))
    body = {"contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0,
                                 "responseSchema": {"type": "OBJECT", "properties": {
                                     "models": {"type": "ARRAY", "items": {"type": "STRING"}},
                                     "batches": {"type": "ARRAY", "items": {"type": "STRING"}},
                                     "upcs": {"type": "ARRAY", "items": {"type": "STRING"}},
                                     "brands": {"type": "ARRAY", "items": {"type": "STRING"}},
                                     "productType": {"type": "STRING"}},
                                     "required": ["models", "batches", "upcs", "brands", "productType"]}}}
    for attempt in range(4):
        r = requests.post(f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
                          headers={"x-goog-api-key": key}, json=body, timeout=120)
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(4 * (attempt + 1))
            continue
        r.raise_for_status()
        return json.loads(r.json()["candidates"][0]["content"]["parts"][0]["text"])
    raise RuntimeError(f"gemini failed for {rec.get('RecallNumber')}: {r.status_code}")


NHTSA_ZIP = os.path.join(ROOT, "ml", "data", "nhtsa", "FLAT_RCL_POST_2010.zip")
NHTSA_URL = "https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip"


def nhtsa_child_seats():
    """NHTSA recalls of child restraints (RCLTYPECD == 'C'), one record per campaign. Field order from NHTSA's
    RCL.txt. The file is fetched with a browser User-Agent (a bare client gets a 20-byte stub) and must be a zip."""
    import io
    import zipfile
    if not os.path.exists(NHTSA_ZIP):
        os.makedirs(os.path.dirname(NHTSA_ZIP), exist_ok=True)
        r = requests.get(NHTSA_URL, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126"}, timeout=180)
        if r.content[:4] != b"PK\x03\x04":
            sys.exit(f"NHTSA returned {len(r.content)} bytes that are not a zip; refusing")
        open(NHTSA_ZIP, "wb").write(r.content)
    z = zipfile.ZipFile(NHTSA_ZIP)
    camps = {}
    for line in io.TextIOWrapper(z.open(z.namelist()[0]), encoding="latin-1"):
        f = line.rstrip("\n").split("\t")
        if len(f) < 23 or f[10].strip() != "C":
            continue
        c = camps.setdefault(f[1].strip(), {"make": f[2].strip(), "models": set(), "bg": [], "end": [], "defect": f[19].strip(),
                                            "remedy": f[21].strip(), "units": f[11].strip(), "date": f[15].strip()})
        c["models"].add(f[3].strip())
        if f[8].strip():
            c["bg"].append(f[8].strip())
        if f[9].strip():
            c["end"].append(f[9].strip())
    out = []
    for camp, c in camps.items():
        ids = {}
        m, b, u = regex_extract(c["defect"])
        for v in m:
            ids.setdefault(("model", fold(v)), {"kind": "model", "value": v, "found_by": ["regex"]})
        for name in c["models"]:
            # multi-word model names only: a single word like "TITAN" collides with too much label text
            if len(name.split()) >= 2 and len(fold(name)) >= 6:
                ids.setdefault(("model", fold(name)), {"kind": "model", "value": name, "found_by": ["nhtsa_model_field"]})
        d = c["date"]
        out.append({
            "source": "NHTSA", "recallNumber": camp, "recallDate": f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else "",
            "title": f"{c['make'].title()} {', '.join(sorted(n.title() for n in c['models']))[:120]} child seat recall",
            "url": f"https://www.nhtsa.gov/recalls?nhtsaId={camp}",
            "products": sorted(c["models"]), "brands": [c["make"].title()], "productType": "child car seat",
            "hazard": c["defect"][:600], "remedy": c["remedy"][:600], "units": c["units"], "images": [],
            "mfgRange": {"from": min(c["bg"]), "to": max(c["end"])} if c["bg"] and c["end"] else None,
            "identifiers": list(ids.values()),
        })
    return out


def build(use_gemini):
    os.makedirs(RAW, exist_ok=True)
    recs = []
    for y in range(2008, datetime.date.today().year + 1):
        d = fetch_year(y)
        recs += d
        print(f"{y}: {len(d)} recalls", flush=True)
    recs = list({r["RecallNumber"]: r for r in recs}.values())
    nursery = [r for r in recs if is_nursery(r)]
    print(f"{len(recs)} recalls total, {len(nursery)} nursery/children")
    key = os.environ.get("GEMINI_API_KEY") if use_gemini else None
    if use_gemini and not key:
        sys.exit("GEMINI_API_KEY not set (or pass --no-gemini)")
    gem, failures = {}, 0
    cache_path = os.path.join(RAW, f"gemini_{MODEL}.json")
    if key:
        gem = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
        todo = [r for r in nursery if r["RecallNumber"] not in gem]
        with cf.ThreadPoolExecutor(8) as ex:
            futs = {ex.submit(gemini_extract, r, key): r["RecallNumber"] for r in todo}
            for i, f in enumerate(cf.as_completed(futs)):
                try:
                    gem[futs[f]] = f.result()
                except Exception as e:
                    failures += 1
                    print("WARN", futs[f], e, file=sys.stderr)
                if i % 50 == 0:
                    print(f"gemini {i}/{len(todo)}", flush=True)
                    json.dump(gem, open(cache_path, "w"))
        json.dump(gem, open(cache_path, "w"))
        if failures:
            # a Gemini pass with failed calls is not a Gemini pass: refuse to write an index that says it was
            sys.exit(f"{failures} of {len(todo)} Gemini calls failed; fix the key/billing or run --no-gemini")
    out, rejected, stats = [], 0, {"regex_models": 0, "gemini_models_kept": 0, "gemini_models_rejected": 0}
    for r in nursery:
        text = text_of(r)
        ftext = fold(text)
        rm, rb, ru = regex_extract(text)
        ids = {}
        for v in rm:
            ids.setdefault(("model", fold(v)), {"kind": "model", "value": v, "found_by": ["regex"]})
        for v in rb:
            ids.setdefault(("batch", fold(v)), {"kind": "batch", "value": v, "found_by": ["regex"]})
        for v in ru:
            ids.setdefault(("upc", v), {"kind": "upc", "value": v, "found_by": ["regex"]})
        stats["regex_models"] += len(rm)
        g = gem.get(r["RecallNumber"]) or {}
        for kind, vals in (("model", g.get("models", [])), ("batch", g.get("batches", [])), ("upc", g.get("upcs", []))):
            for v in vals:
                v = str(v).strip()
                fv = re.sub(r"\D", "", v) if kind == "upc" else fold(v)
                if len(fv) < 3 or (kind != "upc" and not ok_id(v)) or fv not in (re.sub(r"\D", "", text) if kind == "upc" else ftext):
                    stats["gemini_models_rejected"] += kind == "model"
                    rejected += 1
                    continue
                k = (kind, fv)
                if k in ids:
                    ids[k]["found_by"].append("gemini")
                else:
                    ids[k] = {"kind": kind, "value": v, "found_by": ["gemini"]}
                    stats["gemini_models_kept"] += kind == "model"
        upcs = [u for u in r.get("ProductUPCs") or [] if isinstance(u, dict) and u.get("UPC")]
        for u in upcs:
            d = re.sub(r"\D", "", u["UPC"])
            ids.setdefault(("upc", d), {"kind": "upc", "value": d, "found_by": ["cpsc_field"]})
        out.append({
            "source": "CPSC", "recallNumber": r["RecallNumber"], "recallDate": (r.get("RecallDate") or "")[:10],
            "title": r.get("Title"), "url": r.get("URL"),
            "products": [p.get("Name") for p in r.get("Products") or [] if p.get("Name")],
            "brands": g.get("brands", []), "productType": g.get("productType", ""),
            "hazard": "; ".join(h.get("Name", "") for h in r.get("Hazards") or [])[:600],
            "remedy": "; ".join(h.get("Name", "") for h in r.get("Remedies") or [])[:600],
            "units": ", ".join(p.get("NumberOfUnits", "") for p in r.get("Products") or [] if p.get("NumberOfUnits")),
            "images": [i.get("URL") for i in r.get("Images") or [] if i.get("URL")][:4],
            "identifiers": list(ids.values()),
        })
    nhtsa = nhtsa_child_seats()
    out += nhtsa
    out.sort(key=lambda x: x["recallDate"], reverse=True)
    json.dump(out, open(os.path.join(OUT, "recalls.json"), "w"), separators=(",", ":"))
    stats.update({"asOf": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                  "recallsFetched": len(recs), "nurseryRecalls": len(out) - len(nhtsa), "nhtsaChildSeatCampaigns": len(nhtsa),
                  "withAnyIdentifier": sum(1 for x in out if x["identifiers"]),
                  "identifiers": sum(len(x["identifiers"]) for x in out), "geminiValuesRejected": rejected,
                  "geminiModel": MODEL if key and gem else None, "geminiRecords": len(gem)})
    json.dump(stats, open(os.path.join(OUT, "recall_stats.json"), "w"), indent=1)
    print(json.dumps(stats, indent=1))


if __name__ == "__main__":
    build("--no-gemini" not in sys.argv)
