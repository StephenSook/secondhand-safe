# SecondHand Safe

**The money doesn't move until the camera has seen the item.**

Buying a used crib, bassinet or car seat from a stranger? SecondHand Safe holds the buyer's Visa payment
when the deal is agreed. At pickup, one photo of the product label is read (barcode on the phone, label
text by Gemini, product type by our own model running in the browser) and checked against every CPSC
nursery and children's recall, NHTSA's child car seat recalls, plus the product types that are banned outright. Clean: the hold is
captured. Recalled or banned: the hold is reversed, and nobody takes the risk home.

Live: **https://secondhand-safe-web.vercel.app** · Judges: [/judge](https://secondhand-safe-web.vercel.app/judge)

## Try it without logging in

```bash
# CPSC recall 26-061: Harppa high chair, model BHC001, recalled only in batch 202408
curl "https://secondhand-safe-web.vercel.app/api/check?model=BHC001&batch=202408"

# Same model, a different batch: KEEP HELD (the recall names one batch)
curl "https://secondhand-safe-web.vercel.app/api/check?model=BHC001&batch=202511"

# The numbers below, recomputed from the artifacts
curl https://secondhand-safe-web.vercel.app/api/stats
```

## What is measured (all from [`docs/FACTS.json`](docs/FACTS.json), written by `ml/facts.py`)

| | |
|---|---|
| CPSC recalls fetched / nursery and children's kept | 6036 / 1137 |
| NHTSA child car seat recall campaigns (since 2010) | 71 |
| Real marketplace listings scanned | 1662 |
| Banned-type model, held-out macro-F1 (95% CI) | 0.7243 (0.6017 to 0.8127) |
| Off-the-shelf CLIP zero-shot on the same held-out set | 0.558 |
| Ordinary items wrongly flagged, ours vs zero-shot | 2 vs 38 (of 107) |
| Listing scan flags, round 1 then round 2 | 39 then 9 |

The held-out set contains only products the model never saw: no CPSC recall and no marketplace listing
appears on both sides of the split (`ml/train.py`, checked in CI). Every scan flag was reviewed by eye
(`ml/review_rounds/`), and the reviewed false alarms became training data for round 2 without touching the
held-out set.

**What the scan taught us:** on eBay and Craigslist, confirmed banned items were rare (1 in round 1). That
matches Consumer Reports' 2026 evaluation (7 of 400 eBay listings, 2 of 49 Craigslist) against 50 of the
first 65 Facebook Marketplace listings. The big marketplaces filter what they can read in the text. The
gap is peer-to-peer, at the handoff, which is where this check runs.

## How it works

1. **Agree and hold.** Visa Acceptance authorizes the buyer's card with capture off.
2. **Meet and scan.** `/pickup`: one photo; `BarcodeDetector` reads the UPC where the browser supports it,
   Gemini returns only the values printed on the label with their boxes, and a CLIP ViT-B/32 embedding plus
   our trained head classifies the product type in the browser (transformers.js).
3. **Check.** `src/server/recalls/match.ts`: O/0 and I/1 folding, batch-restricted recalls, and the legal
   rules (inclined sleepers and padded crib bumpers banned, mesh liners excepted, drop-side cribs not
   resellable, in-bed sleepers and car seats need a check). The vocabulary never says "safe".
4. **Capture or reverse.**

## Repo map

- `src/` Next.js 16 app: landing, `/pickup`, `/judge`, public API (`/api/check`, `/api/stats`, `/api/health`, `/api/label`).
- `data/build_recall_index.py` CPSC recall index; `data/handcheck.md` the hand checks and the defects they found.
- `ml/` harvest, review sheets, training, eval, scan, facts. `docs/design/` the motion reference study.
- CI: lint, typecheck, unit tests, build, pytest, classifier parity (JS vs sklearn), Playwright e2e, gitleaks, em-dash gate.

## Status and honesty

Live on this deployment today: the CPSC recall index and matcher, the classifier, the pickup scan's
barcode and on-device model. The Visa Acceptance hold, MongoDB Atlas, the Gemini label reader, ElevenLabs
voice and the Solana passport are wired as each gets keys; `/judge` shows which are live, read from the
server's configuration, so nothing is claimed early.

Team: Stephen Sookra (frontend, AI/ML, mobile) and Tylin (backend). HackGT 13, Sep 25-27 2026. Plan:
[PLAN.md](PLAN.md).
