"""Download listing and recall photos to ml/data/img/, verifying CONTENT, never trusting the status code.

A WAF or CDN can answer HTTP 200 with a small HTML challenge page. A file is written only when its bytes
start with a JPEG/PNG/WEBP/GIF signature and it is at least MIN_BYTES long, so a block page can never
enter the dataset under an image filename.

  python ml/fetch_images.py ml/data/listings.jsonl ml/data/cpsc_images.jsonl [--first-only]
"""
import hashlib
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(HERE, "data", "img")
MIN_BYTES = 3000
SIGS = (b"\xff\xd8\xff", b"\x89PNG", b"GIF8", b"RIFF")
UA = {"User-Agent": "Mozilla/5.0 (Macintosh) SecondHandSafe-research (HackGT 13)"}
SLOW_HOSTS = ("cpsc.gov", "saferproducts.gov")   # government hosts: one request every 3 s


def image_path(url):
    return os.path.join(IMG, hashlib.sha1(url.encode()).hexdigest()[:16] + ".img")


def is_image(b):
    return len(b) >= MIN_BYTES and b.startswith(SIGS) and (not b.startswith(b"RIFF") or b[8:12] == b"WEBP")


def fetch(url):
    p = image_path(url)
    if os.path.exists(p):
        return url, "cached"
    try:
        r = requests.get(url, headers=UA, timeout=30)
    except requests.RequestException as e:
        return url, f"error {type(e).__name__}"
    if not is_image(r.content):
        return url, f"rejected {r.status_code} {len(r.content)}B {r.headers.get('content-type')}"
    with open(p + ".part", "wb") as fh:
        fh.write(r.content)
    os.replace(p + ".part", p)
    return url, "ok"


def main(paths, first_only):
    os.makedirs(IMG, exist_ok=True)
    urls = []
    for path in paths:
        with open(path) as fh:
            for line in fh:
                imgs = json.loads(line)["images"]
                urls += imgs[:1] if first_only else imgs[:4]
    slow = [u for u in urls if urlparse(u).hostname and urlparse(u).hostname.endswith(SLOW_HOSTS)]
    fast = [u for u in urls if u not in set(slow)]
    stats = {}
    with ThreadPoolExecutor(8) as ex:
        for _, s in ex.map(fetch, fast):
            k = s.split()[0]
            stats[k] = stats.get(k, 0) + 1
    for u in slow:
        _, s = fetch(u)
        k = s.split()[0]
        stats[k] = stats.get(k, 0) + 1
        if s != "cached":
            time.sleep(3)
        if s.startswith("rejected"):
            print("WARN", u, s, file=sys.stderr)
    print(f"{len(urls)} urls: {stats}")
    if not stats.get("ok") and not stats.get("cached"):
        sys.exit("no images downloaded")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    main(args, "--first-only" in sys.argv)
