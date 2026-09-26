# Recall index hand check (PLAN 1.2)

Two seeded random samples of 20 recalls each, read against the full CPSC description text on 2026-09-26.

## Sample 1 (seed 20260926), first build

- Identifiers read correctly: W046, RV001, S0008A, m-sy2, 92-8112, all four Oeuf SPCR models, all six
  Babycottons styles, Munchkin model 13301 + lot TP-1487 + UPC.
- Defects found, each fixed in `build_recall_index.py`:
  - List items after ", and" were dropped (7FT5515 lost from "7FT5655, 7FT5455, and 7FT5515").
  - Lot lists kept only the first value (1 of 4 lot numbers on recall 20126).
  - 4 of 20 records were not nursery or children's products (a pain roll-on, an outdoor cleaner, gel fuel,
    vitamins). They matched "children" through "child-resistant packaging" in the description. The filter
    now reads the title and product names only, and excludes child-resistant packaging notices.
- Still wrong, not fixed by regex: tabular notices ("Model # Description Date Code") put a model number
  in the batch column (13151, 19042).

## Sample 2 (seed 7), after the fixes

- 19 of 20 are children's or nursery products. One borderline: a patio swing matched "swing".
- New defects found and fixed: bare years became batch codes ("2020", "2018"); "71591/71844" stayed one
  token.
- Misses that remain: table layouts (a baby-monitor recall listing models in a table, a toy recall with
  a description table). These are the phrasings the Gemini extraction pass exists for.

## Third defect, found by the listing scan (PLAN 2.9)

- Scanning real listings matched "4-in-1", "3-in-1", "6-Piece", "4-Drawer" and years as recall models.
  Cause: an earlier fix made the list separator optional, so the model regex chained across ordinary words
  ("style 4-in-1 style cribs model number 5601 ... January 2012 through August 2012"). Fixed: a real
  separator (comma, and, or, &) is required, punctuation is stripped before filtering, and description
  shapes (N-in-1, N-piece, N-drawer, sizes, years) are rejected in the builder AND in the app matcher.

## Status

- Counts are written by the script to `recall_stats.json` and published in `docs/FACTS.json`; read them
  there, not here.
- The Gemini pass is built but has not run: the API key's project has no prepaid credit (HTTP 402 on
  every call, 2026-09-26). The script refuses to write an index that claims a Gemini pass when any call
  failed.
