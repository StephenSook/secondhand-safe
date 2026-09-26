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
- The Gemini pass ran on 2026-09-26 with `gemini-3.5-flash` through Vertex AI (the AI Studio key's project
  was still on a depleted prepay account). All 1,137 nursery recalls were read; one call timed out and the
  script refused to write, and the rerun retried only that record from the cache. A value Gemini returns is
  kept only if it appears verbatim in that recall's own text (`geminiValuesRejected` counts the ones that
  did not).
- Recalls with any identifier rose from 449 (regex only) to 822.
- A spot check of the new values found two shapes that needed rules, both now in place:
  1. Short all-digit model numbers ("4340", listed by Delta's drop-side crib recalls). They are shared
     across brands, and brand names are often ordinary words ("Summer", "Gap", "Place") that listing text
     contains anyway, so text cannot confirm the brand. A match on one is always NEEDS_CHECK, naming the
     brand, and never moves money (tests/match.test.ts; found by two review rounds).
  2. Batch values that are production-date phrases ("production dates 01/06 thru 11/07"). They can never
     equal a printed batch code, so a model hit on such a recall is NEEDS_CHECK (the hold waits for a
     person). That is conservative, never a wrong reversal.
