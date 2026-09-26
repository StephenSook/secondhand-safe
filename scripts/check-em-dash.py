"""Fail if any judge-facing text contains an em dash (U+2014) or en dash (U+2013).

Scans tracked AND untracked-but-not-ignored files, so a new file is checked before its first commit.
Exits non-zero on a hit, and also when it scanned zero files (a scan that walks nothing is not clean).
"""
import subprocess
import sys

EXTS = (".md", ".tsx", ".ts", ".mdx", ".json", ".html", ".css")
SKIP = ("node_modules/", "ml/", "docs/IMPLEMENTATION.md", "package-lock.json", "AGENTS.md", "CLAUDE.md",
        "scripts/check-em-dash.py", "docs/design/")
BAD = {"—": "em dash", "–": "en dash"}

files = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard"],
                       capture_output=True, text=True, check=True).stdout.split()
files = [f for f in files if f.endswith(EXTS) and not f.startswith(SKIP)]
if not files:
    sys.exit("check-em-dash: scanned 0 files, refusing to report clean")
hits = 0
for f in files:
    try:
        for n, line in enumerate(open(f, encoding="utf-8"), 1):
            for ch, name in BAD.items():
                if ch in line:
                    print(f"{f}:{n}: {name}: {line.strip()[:100]}")
                    hits += 1
    except (UnicodeDecodeError, FileNotFoundError):
        continue
print(f"check-em-dash: {len(files)} files scanned, {hits} hits")
sys.exit(1 if hits else 0)
