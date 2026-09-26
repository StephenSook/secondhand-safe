# Lullabuy

*(repo name: secondhand-safe)* · **lullabuy.tech**

**The money doesn't move until the camera has seen the item.**

Buying a used crib, bassinet or car seat from a stranger? Lullabuy holds the buyer's Visa payment
when the deal is agreed. At pickup, one photo of the product label is read (barcode on the phone, label
text by Gemini, product type by our own model running in the browser) and checked against every CPSC
nursery and children's recall, NHTSA's child car seat recalls, plus the product types that are banned outright. Clean: the hold is
captured. Recalled or banned: the hold is reversed, and nobody takes the risk home.

Live: **https://lullabuy.tech** · Judges: [/judge](https://lullabuy.tech/judge)

## Try it without logging in

```bash
# CPSC recall 26-061: Harppa high chair, model BHC001, recalled only in batch 202408
curl "https://lullabuy.tech/api/check?model=BHC001&batch=202408"

# Same model, a different batch: KEEP HELD (the recall names one batch)
curl "https://lullabuy.tech/api/check?model=BHC001&batch=202511"

# The numbers below, recomputed from the artifacts
curl https://lullabuy.tech/api/stats

# The same check as an MCP tool, for any AI shopping agent (Streamable HTTP, stateless)
curl -s https://lullabuy.tech/api/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recall_check","arguments":{"model":"BHC001","batch":"202408"}}}'
```

MCP config for a client that speaks Streamable HTTP:
`{"mcpServers":{"lullabuy":{"type":"http","url":"https://lullabuy.tech/api/mcp"}}}`

## What is measured (all from [`docs/FACTS.json`](docs/FACTS.json), written by `ml/facts.py`)

| | |
|---|---|
| CPSC recalls fetched / nursery and children's kept | 6036 / 1136 |
| NHTSA child car seat recall campaigns (since 2010) | 71 |
| Nursery recalls with a model, batch or UPC on file (regex + Gemini, each value found verbatim in the recall) | 820 |
| Real marketplace listings scanned | 1662 |
| Banned-type model, held-out macro-F1 (95% CI) | 0.7243 (0.6017 to 0.8127) |
| Off-the-shelf CLIP zero-shot on the same held-out set | 0.558 |
| Ordinary items wrongly flagged, ours vs zero-shot | 2 vs 38 (of 107) |
| Listing scan flags, round 1 then round 2 | 39 then 9 |
| Deep fine-tune of CLIP's last 2 blocks, same held-out set (experiment, not shipped) | 0.7469 (0.6258 to 0.8329), 0 of 107 false alarms |

The held-out set contains only products the model never saw: no CPSC recall and no marketplace listing
appears on both sides of the split (`ml/train.py`, checked in CI). Every scan flag was reviewed by eye
(`ml/review_rounds/`), and the reviewed false alarms became training data for round 2 without touching the
held-out set.

**What the scan taught us:** on eBay and Craigslist, confirmed banned items were rare (1 in round 1). That
matches Consumer Reports' 2026 evaluation (7 of 400 eBay listings, 2 of 49 Craigslist) against 50 of the
first 65 Facebook Marketplace listings. The big marketplaces filter what they can read in the text. The
gap is peer-to-peer, at the handoff, which is where this check runs.

## How it works

0. **Find it.** `/shop`: say or type what you need. Gemini 3.5 Flash turns it into filters over 1,662 real
   eBay and Craigslist listings we scanned, and every result arrives pre-screened (recall index, our photo
   model, our own review). Red listings cannot be bought, and the server enforces it.
1. **Agree and hold.** The buyer types the card into Visa Acceptance **Microform** fields (Visa's iframes,
   so the card number never reaches our server). The transient token is authorized with capture off. An AI
   agent buying for a parent signs its request with the **Trusted Agent Protocol** (RFC 9421, Ed25519),
   and an edited amount or a replayed request is refused before Visa is called.
   A buyer can save the card with Visa's **Token Management Service** and pay the next hold without
   re-entering it; when Visa applies a card-linked offer, the hold is the discounted amount.
2. **Meet and scan.** `/pickup`: one photo; `BarcodeDetector` reads the UPC where the browser supports it,
   Gemini returns only the values printed on the label with their boxes, and a CLIP ViT-B/32 embedding plus
   our trained head classifies the product type in the browser (transformers.js).
3. **Check.** `src/server/recalls/match.ts`: O/0 and I/1 folding, batch-restricted recalls, and the legal
   rules (inclined sleepers and padded crib bumpers banned, mesh liners excepted, drop-side cribs not
   resellable, in-bed sleepers and car seats need a check). The vocabulary never says "safe".
4. **Both sides see it.** Every hold and settlement is recorded in MongoDB Atlas; the seller scans a QR on
   the buyer's screen and watches the same deal live (`/deal/<id>`), and `/board` shows every deal.
5. **Capture or reverse.** A captured sale gets an item passport: the SHA-256 of the pickup record written to
   Solana devnet in a Memo transaction, which `/passport/<signature>` reads back and recomputes: it checks the
   signer is our passport key, that the transaction succeeded, and that the hash matches.

## Mobile app (iOS and Android)

`mobile/` is an Expo app (SDK 57) with three tabs that call the same live API: Shop (Gemini agent), Scan label
(camera photo, Gemini reads it, the recall check runs, the phone speaks the verdict) and Deal board. To try it
on a phone: install Expo Go, then `cd mobile && npm install && npx expo start` and scan the QR code.

## Repo map

- `src/` Next.js 16 app: landing, `/shop`, `/pickup`, `/passport`, `/judge`, public API (`/api/check`, `/api/stats`, `/api/health`, `/api/label`, `/api/mcp`, `/api/shop`). Gemini in production uses no stored key: Vercel's OIDC token is exchanged through Google Workload Identity Federation (`src/server/ml/gcpToken.ts`).
- `data/build_recall_index.py` CPSC recall index; `data/handcheck.md` the hand checks and the defects they found.
- `ml/` harvest, review sheets, training, eval, scan, facts. `docs/design/` the motion reference study.
- `mobile/` Expo app. CI: lint, typecheck, unit tests, build, pytest, mobile typecheck and expo-doctor, classifier parity (JS vs sklearn), Playwright e2e, gitleaks, em-dash gate.

## Status and honesty

Live on this deployment (checked with `GET /api/health`, which reads the server's configuration and
reports every integration as true or false, so nothing is claimed early): the CPSC and NHTSA recall index
and matcher, the classifier, the Visa Acceptance sandbox hold (Microform, Token Management Service, card-
linked promotions), the Trusted Agent Protocol, MongoDB Atlas (deal store, board, seller view, Trust and
Safety console at `/trust`), the Gemini label reader (keyless: Vercel OIDC to Google Cloud Workload
Identity Federation), ElevenLabs voice, the Solana devnet passport, and a daily hold sweeper.
Known limits of the settlement path, all failing toward "no money moves":
- One settlement per deal is enforced with an atomic claim in MongoDB Atlas (`settle_claims`) before any Visa call. The deal record is read first, and a deal it already shows as ended is never settled again. If Atlas is down, `/api/pickup` refuses to settle (503, `visaCalled: false`). A scan that moves no money then reports UNKNOWN, not HELD.
- A claim is never taken over. If an attempt dies before storing its result, later scans of that deal get UNKNOWN, with no second Visa call. The deal record and the Visa Business Center then hold the answer.
- A UPC counts only with a valid GTIN check digit. An invalid one is ignored: alone it reads UNREADABLE, and with a model that matched nothing it reads NEEDS_CHECK. Either way the hold stays.
- A GTIN-14 case code (indicator 1 to 8) is also checked as the item it contains. Recall UPCs printed incomplete (10 or 11 digits) cannot be matched for certain, so any code containing one keeps the hold (NEEDS_CHECK).

Sandbox only: no real money moves. The deals on `/board` and `/trust` are our own demo purchases and our
automated end-to-end tests, which run against this live site.

Team: Stephen Sookra (frontend, AI/ML, mobile) and Tylin (backend). HackGT 13, Sep 25-27 2026. Plan:
[PLAN.md](PLAN.md).
