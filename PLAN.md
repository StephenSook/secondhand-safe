# SECONDHAND SAFE: Plan & Coordination

> Living status doc for Stephen + Tylin. Updated on every task change and pushed to `main`.
> Single source of truth for who is working on what.
> **Atomic commits. Never bundle a status change with code.**

**Project:** SecondHand Safe, a used-baby-gear checkout where the Visa payment is held until a camera has
seen the item.

**Team:**
- **Stephen:** frontend, AI/ML/DL (classifier, label reader, agent, voice), mobile (Expo iOS), Checkpoint
  kiosk, submission.
- **Tylin:** backend (Visa Acceptance + Visa Developer rails, Trusted Agent Protocol, MongoDB Atlas, recall
  index, deal state machine, Solana, API routes, CI, deploy, probes).

**Hackathon:** HackGT 13 "Seaside Market", Georgia Tech, Sep 25-27 2026.

**Deadline:** **Sunday Sep 27, 8:00 AM ET, hard.** Submit to **Devpost AND expo.hexlabs.org** ("or you
will not be judged"). **Target submit: Sun 6:30 AM.** Expo Sun 9:30-11:00 AM, Klaus Atrium.

**Repo:** `github.com/StephenSook/secondhand-safe`, public.

**Master spec:** `../research/71-SECONDHAND-SAFE-BUILD-PLAN.md` (in the team workspace, not in this repo).
Task-level TDD steps with code: `docs/IMPLEMENTATION.md`. If this file drifts from them, fix this file.

**Legend:** ✅ done · 🟡 in progress · ⬜ not started · ⛔ blocked · ✂️ cut

**Stale lock TTL: 4 hours.** A 🟡 task without a fresh timestamp in Notes is claimable.

**Coordination is manual.** Edit this file by hand, commit only `PLAN.md`, push. Commit message:
`status: <task#> <emoji> <description>`.

---

## Context: why this exists

- **The problem:**
  - CPSC: about 100 infant deaths in one recalled sleeper, at least 8 after the recall. It is "illegal to
    sell any recalled product".
  - Consumer Reports (Sep 23 2026) found 50 of the first 65 Facebook Marketplace listings it reviewed were
    in-bed sleepers.
  - Listing filters read text. Nobody reads the label when the cash changes hands.
- **Our answer uses Visa's own mechanic:**
  - authorize at agreement, capture only after the camera and barcode check at pickup, reverse if recalled
    or banned;
  - Trusted Agent Protocol signs the shopping agent's requests.

**Tracks we enter:**
- General: **Oracle of the Deep** (ML/AI + visualization).
- Sponsors (max 2): **Visa** ($5,000) + **Notability**.
- MLH: **MongoDB Atlas, Solana, ElevenLabs, .Tech, Gemini API**, plus **Vultr / Tiger Data / Backboard**
  only if their job below is really wired.
- No Create-X: neither of us is a GT student.

---

## Judged criteria and the surfaces that answer them

| Criterion | Surface that answers it | Owner |
|---|---|---|
| Visa: GenAI commerce + "secure and trusted payments" | The Deal Board glass card, HELD then CAPTURED or REVERSED, live from the Visa Acceptance sandbox, plus a TAP-signed agent request and its tamper rejection | Tylin (rails) + Stephen (board) |
| Visa: journey stages | Discovery (agent), decision (verdict), checkout (auth), payments (capture/reversal, Visa Direct payout), post-purchase (Solana passport + recall watch) | both |
| Oracle of the Deep: "sees what no one else can" | `/map` + `/atlas`: a measured scan of real Atlanta listings, with the trained classifier's held-out accuracy printed beside it | Stephen |
| MLH judge: "only possible with the partner tool", "demos over slides", hardware kudos | Atlas fuzzy match + change streams, Solana passport on an NFC sticker, the table Checkpoint with the NFC reader and barcode scanner | Tylin + Stephen |
| Execution / judge door | `/judge`: a numbered 3-minute itinerary, no login, and public `GET /api/check?model=BHC001` + `GET /api/stats` that recompute live | Tylin + Stephen |

**The headline number:** "X of N real Atlanta-area listings flagged".
- **X and N are placeholders until a real scan produces them** (task 2.9).
- They are written once to `docs/FACTS.json`, and the README, `/judge`, the video and Devpost all read from
  that file. A test enforces this (task 3.4).
- **Never type a number from memory.**

---

## Status Dashboard

### Phase 0: Scaffold, keys, first Visa call (Fri Sep 25, 11 PM to Sat 2 AM)

| # | Component | File(s) | Owner | Status | Deps | Notes |
|---|---|---|---|---|---|---|
| 0.1 | Repo, `.gitignore`, `.env.example`, README stub, this plan | root | **Stephen** | ✅ | n/a | Commit one. Tylin invited (write). |
| 0.2 | Next.js scaffold in place (TS, App Router, `src/`), deps from IMPLEMENTATION Task 1 | `src/**`, `package.json` | **Stephen** | ✅ | 0.1 | Next.js 16.3, Tailwind v4, src/. PR #2. | |
| 0.3 | Env contract `src/server/env.ts` + test | `src/server/env.ts`, `tests/env.test.ts` | **Stephen** | ✅ | 0.2 | src/server/env.ts: parseEnv names every missing key; requireEnv per feature; integrationStatus booleans only. | |
| 0.4 | CI: lint, typecheck, vitest, pytest, build, gitleaks, em-dash gate | `.github/workflows/ci.yml` | **Stephen** | ✅ | 0.2 | CI: web, ml, e2e (parity + Playwright), hygiene (em dash + gitleaks). Bare gates. Probe workflow (PR #6). | |
| 0.5 | Accounts + keys (each person signs up themselves, keys move by AirDrop only) | local `.env.local` | **Tylin**: Visa Acceptance sandbox, Visa Developer project (Visa Direct + Payment Passkey), Atlas M0. **Stephen**: Gemini, ElevenLabs + .Tech (MLH email), eBay keyset, Vercel, Solana devnet wallet, Notability QR, HexLabs OpenAI key | 🟡 | n/a | DONE: Vercel prod has Visa sandbox + TAP + ElevenLabs keys (push-env.sh, pipefail bug fixed); Gemini in prod is KEYLESS (Vercel OIDC -> Workload Identity Federation -> SA with aiplatform.user on Curtail credits). Open: Atlas M0 (account), VDP project (account), faucet SOL (GitHub login). | |
| 0.6 | **Gate:** sandbox auth → capture, and auth → reversal, from a live test | `src/server/visa/acceptance.ts`, `tests/visa.live.test.ts` | **Stephen** | ✅ | 0.3, 0.5 | Live: AUTHORIZED -> capture PENDING, AUTHORIZED -> REVERSED (tests/visa.live.test.ts) on Cybersource's PUBLIC sample merchant 'testrest'. Tylin: swap in your own sandbox keys so transactions show in your Business Center. $40.00 is a simulator AVS trigger. | |

### Phase 1: Core loop (Sat 12 AM to 6 AM)

| # | Component | File(s) | Owner | Status | Deps | Notes |
|---|---|---|---|---|---|---|
| 1.1 | Trusted Agent Protocol sign + verify + tamper tests | `src/server/tap/tap.ts`, `tests/tap.test.ts` | **Stephen** | ✅ | 0.3 | Merged PR #10 + review fixes (signature before nonce, capped nonce, identity+integrity wording, $200 agent cap). Prod needs TAP key pushed. | | | |
| 1.2 | Recall index: CPSC + NHTSA → Atlas, with a 20-record hand check | `data/build_recall_index.py`, `data/handcheck.md` | **Stephen** | ✅ | 0.5 | 6,036 CPSC recalls -> 1,137 nursery. Gemini 3.5 Flash pass (Vertex, Sat 8 AM): 449 -> 822 with identifiers, values kept only if verbatim in the recall. Short numeric models need the brand. data/handcheck.md. | |
| 1.3 | Verdict rules + fuzzy matcher (O/0, I/1 folding) | `src/core/verdict.ts`, `src/server/recalls/match.ts` | **Stephen** | ✅ | 1.2 | src/server/recalls/match.ts + tests: folding, batch rule (26-061 recalls BHC001 only in batch 202408), D3 rules, junk-id guard. | |
| 1.4 | Atlas indexes + change stream → `/api/stream` (SSE) | `src/server/db/mongo.ts`, `src/app/api/stream/route.ts` | **Tylin** | ⬜ | 0.5 | M0 allows 3 search/vector indexes max. |
| 1.5 | Deal state machine + `/api/checkout` + `/api/pickup` + hold sweeper | `src/server/deals/machine.ts`, `src/app/api/{checkout,pickup,cron}/**` | **Stephen** | 🟡 | 0.6, 1.1, 1.3 | Stateless: the Visa authorization IS the deal; HMAC deal token; 4 adversarial review rounds (replay -> REFUSED, network -> UNKNOWN, allowlist, no concurrent settle). Missing: hold sweeper, Atlas history for the board. | | | |
| 1.6 | Listing harvest (1,000+ real listings, eBay + Craigslist Atlanta) | `ml/harvest.py` | **Stephen** | ✅ | 0.5 | 1,662 listings (613 Craigslist, 1,049 eBay) + 243 CPSC photos, contact info redacted. Loads into Atlas `listings` once 0.5 exists. Finding: eBay already filters bumpers and Rock 'n Plays. |
| 1.7 | Classifier dataset + training + eval vs zero-shot | `ml/embed.py`, `ml/train.py`, `ml/eval.py`, `ml/labels.csv` | **Stephen** | ✅ | 1.6 | Head now trained on transformers.js q8 embeddings (the phone runtime). Held-out macro-F1 0.724 [0.60, 0.81] vs 0.558 zero-shot; 2/107 vs 38/107 false alarms. Numbers live in docs/FACTS.json. | |
| 1.8 | Label reader: Gemini vision JSON + boxes, OpenAI fallback | `src/server/ml/label.ts`, `tests/label.live.test.ts` | **Stephen** | ✅ | 0.5 | Live via Vertex on a real CPSC label photo (KMART 07-1248 -> recall 11020, tests/label.live.test.ts). Prod needs a Gemini key on a funded project (see 0.5). | |
| 1.9 | Pickup page with live scan overlay + upload fallback | `src/app/pickup/**`, `src/ui/ScanOverlay.tsx` | **Stephen** | ✅ | 1.8 | /pickup: photo, BarcodeDetector UPC, Gemini label, on-device classifier, editable fields, real hold settlement, spoken verdict. | |
| 1.10 | Deal Board (glass card per deal, live via SSE) | `src/app/board/**`, `src/ui/GlassDealCard.tsx` | **Stephen** | ⬜ | 1.4 | Nova components. HELD amber, CAPTURED green, REVERSED red, a sound per state. |

**CHECKPOINT Sat 6 AM:** both demo deals work end to end on localhost (Deal 1 REVERSED on the printed
26-061 label, Deal 2 CAPTURED on the real item). If not, stop and fix together before anything in Phase 2.

### Phase 2: Deploy + depth (Sat 6 AM to 2 PM)

| # | Component | File(s) | Owner | Status | Deps | Notes |
|---|---|---|---|---|---|---|
| 2.1 | Vercel deploy (dedicated project `secondhand-safe-web`) + CI e2e + live probe | `.github/workflows/probe.yml` | **Stephen** | ✅ | 1.5 | https://secondhand-safe-web.vercel.app; vercel.json pins nextjs; probe.yml every 30 min asserts real verdicts. Playwright suite passes against production. | |
| 2.2 | Public `/api/check`, `/api/stats`, `/api/health` | `src/app/api/{check,stats,health}/**` | **Stephen** | ✅ | 1.3 | /api/check (GET for curl, POST), /api/stats, /api/health, all from artifacts. | |
| 2.3 | Solana passport (Metaplex Core) + memo anchor | `src/server/solana/passport.ts` | **Tylin** | ⬜ | 1.5 | Devnet. Fund the wallet Friday. |
| 2.4 | Microform card entry + TMS token | `src/server/visa/acceptance.ts` | **Tylin** | ⬜ | 0.6 | Card number never touches our server. |
| 2.5 | Visa Direct push funds to seller + Visa Payment Passkey step-up | `src/server/visa/direct.ts` | **Tylin** | ⬜ | 0.5 | VDP sandbox, two-way SSL. |
| 2.6 | Recall watch (Atlas trigger) + web push | `src/server/watch/**` | **Tylin** | ⬜ | 2.3 | Replay recall 26-568 in the demo, labelled as a replay. |
| 2.7 | Shop page + Gemini agent (search, prescreen, TAP-signed checkout) | `src/app/(shop)/**`, `src/server/ml/agent.ts` | **Stephen** | ✅ | 1.3, 1.1 | /shop: Gemini 3.5 Flash parses the request (typed or spoken) into filters over 1,662 real scanned listings; every result pre-screened (recall index + photo model + human review); red refused server-side; TAP-signed agent hold hands off to /pickup. Two review rounds fixed. |
| 2.8 | Classifier runtime in Node (CLIP + trained head, parity test with Python) | `src/server/ml/classify.ts`, `public/models/head.json` | **Stephen** | ✅ | 1.7 | In-browser CLIP q8 + head.json; parity suite in CI: head math = sklearn to 1e-5; cross-platform q8 cosine 0.987 to 0.996, same class. | |
| 2.9 | Measured scan of all harvested listings + hand review of red flags | `ml/scan.py`, `ml/review.csv`, `docs/FACTS.json` | **Stephen** | ✅ | 1.6, 1.7, 1.3 | 1,662 listings scanned. Round 1: 39 flags, 1 real (reviewed by eye). 23 false alarms -> train-only hard negatives -> round 2: 9 flags. HONEST: X of N is tiny on eBay/Craigslist (matches CR's 7/400, 2/49); lead with CR's 50/65 + the learning loop instead. | |
| 2.10 | Checkpoint kiosk (barcode + camera) + NFC bridge for the ACR122U | `src/app/checkpoint/**`, `bridge/index.mjs` | **Stephen** | ⬜ | 1.5 | NFC writes `PUBLIC_BASE_URL/passport/<asset>` to the sticker. No wiring or LilyPad (D5). |
| 2.11 | ElevenLabs spoken verdict (EN + ES) + voice agent | `src/server/voice/elevenlabs.ts` | **Stephen** | 🟡 | 1.5 | /api/voice fixed lines EN + ES (voice Sarah, eleven_flash_v2_5), live test passes. Production needs ELEVENLABS_API_KEY pushed. | |
| 2.12 | Visa workshop, Klaus 1443 (Sat 10-11 AM). Ask: who judges, VIC creds, the hold mechanic | n/a | **Stephen + Tylin** | ⬜ | n/a | 30 swag points. |

### Phase 3: Galaxy tier + hardening (Sat 2 PM to 9 PM)

| # | Component | File(s) | Owner | Status | Deps | Notes |
|---|---|---|---|---|---|---|
| 3.1 | Expo iOS pickup scanner (on-device OCR) | `mobile/**` | **Stephen** | ⬜ | 1.5 | Runs on Stephen's iPhone. The PWA stays the judge path. |
| 3.2 | `/map` (deck.gl hex), `/atlas` (embedding-atlas), `/trust` (T&S console), `/judge`, `/passport/[id]` | `src/app/**` | **Stephen** | 🟡 | 2.9 | /judge ✅, /map ✅, /atlas ✅ (t-SNE of 1,834 images). Not built: /trust console, /passport (needs Solana devnet SOL: faucet dry). | | | |
| 3.3 | MCP server `recall_check` for AI shopping agents (HTTP) | `src/app/api/mcp/route.ts` | **Stephen** (took over) | ✅ | 2.2 | /api/mcp, stateless Streamable HTTP, read-only recall_check; curl + config in README; tests/mcp.test.ts. |
| 3.4 | FACTS test: README, `/judge`, submission numbers equal `docs/FACTS.json` | `tests/facts.test.ts` | **Stephen** | ✅ | 2.9 | tests/facts.test.ts: README numbers == docs/FACTS.json. | |
| 3.5 | Codex adversarial review of payments + TAP + matcher, repeated until a clean round | n/a | **Tylin** | ⬜ | 1.5 | Before footage. Record rounds in Notes. |
| 3.6 | Stills of every judge page (desktop + phone) from the deployed origin | `docs/stills/` | **Stephen** | ✅ | 2.1 | Stills of /, /pickup, /judge, /map, /atlas from the deployed origin, desktop + phone: 0 console errors, 0 overflow (Sat 5:55 AM). Re-run after key push. | | | |
| 3.7 | Tier 3 (only once Phase 1-2 are ✅ on main): Vultr inference, Tiger Data trend, Backboard memory, YOLO label finder, Apple Wallet pass, USDC payout | various | split | ⬜ | Phase 2 | Each gets wired or cut, never claimed half-built. |
| 3.8 | Aardvark-style motion system + art (design study docs/design/aardvark-reference.md) | `src/ui/**`, `public/art/**` | **Stephen** | ✅ | n/a | Preloader stroke wipe, elastic words, fanned cards, pinned scroll-scrub scan (generated, captioned), floating gear, parallax footer. |
| 3.9 | Microform card entry (replaces the server-side sandbox test card) | `src/server/visa/microform.ts`, `/pickup` | **Stephen** (took over) | ✅ | 0.6 | Visa Microform v2 fields, transient token into authorize(); live e2e green; review round 1 fixed (loading guard, card source on the hold, expiry, origin, rate limit). |
| 3.10 | TAP-signed agent checkout (RFC 9421 ed25519) + tamper demo | `src/server/tap/**` | **Stephen** | ✅ | 1.5 | Same as 1.1. | | | |
| 3.11 | Atlas: recalls + deals + listings, change stream -> Deal Board | `src/server/db/**`, `/board` | **Tylin** (DB) + **Stephen** (board) | ✅ | 0.5 | Atlas M0 "lullabuy": deals recorded via waitUntil; /board; e2e seller.spec on prod. |
| 3.12 | Solana devnet passport + memo of the verification hash | `src/server/solana/**` | **Stephen** (took over) | ✅ | 1.5 | Live: devnet wallet funded (faucet, Stephen GitHub auth); capture writes a Memo passport; /passport verifies signer + success + hash; e2e passport.spec on prod. | |
| 3.13 | NHTSA child-seat recalls into the index | `data/build_recall_index.py` | **Stephen** | ✅ | 1.2 | 71 NHTSA child-restraint campaigns with manufacture date ranges; date rule in the matcher (PR #8). | |
| 3.14 | Expo iOS pickup scanner | `mobile/**` | **Stephen** | ⬜ | 1.9 | The PWA is the judge path. |
| 3.15 | Seller-side confirmation of the pickup scan (today the buyer's device reports it; review finding) | `/pickup`, `src/app/api/pickup/**` | **Tylin** + **Stephen** | ✅ | 1.5 | Seller live view /deal/<id> via QR on the buyer pickup screen (reads Atlas every 3 s). The buyer device still reports the scan; noted in Q&A. |

### Phase 4: Freeze + submit (Sat 9 PM to Sun 8 AM)

| # | Component | File(s) | Owner | Status | Deps | Notes |
|---|---|---|---|---|---|---|
| 4.1 | Claims audit: grep the code for every named product; `.env.example` parity; gitleaks full history | `docs/claims-audit.md` | **Tylin** | ⬜ | all | |
| 4.2 | Demo video 2-3 min (loudness + duration measured) | `docs/video/` | **Stephen** | ⬜ | 3.6 | |
| 4.3 | Devpost writeup (Visa Acceptance + Trusted Agent Protocol named 3+ times, MongoDB Atlas, Solana), Notability note + 2 screenshots, .Tech domain | `docs/submission.md` | **Stephen** | 🟡 | 4.1 | docs/submission-draft.md: numbers from FACTS.json; TODOs for the parts only Stephen/Tylin can write (inspiration, what we learned). | |
| 4.4 | Submit to **Devpost AND expo.hexlabs.org**, every box checked, reload-verify both | n/a | **Stephen** | ⬜ | 4.3 | By Sun 6:30 AM. |
| 4.5 | Post-merge main CI verified on the merged SHA (count ≥ jobs, none failing) + probe green and young | n/a | **Tylin** | ⬜ | 4.4 | Never trust a `--watch` exit code. |

---

## Shared Contracts

| Contract | Owner | Consumers | Definition |
|---|---|---|---|
| `Verdict` | Tylin | Stephen (UI, voice, mobile) | `{kind: "RECALL_MATCH"\|"BANNED_TYPE"\|"NO_MATCH"\|"UNREADABLE"\|"NEEDS_CHECK", recall?: RecallDoc, reason: string, asOf: string}` |
| `readLabel()` output | Stephen | Tylin (`/api/pickup`) | `{readable, brand?, model?, batch?, date?, boxes:[{field,x,y,w,h}], ms}` |
| `classify()` output | Stephen | Tylin (matcher), Stephen (UI) | `{cls: "inclined_or_inbed_sleeper"\|"crib_bumper"\|"drop_side_crib"\|"other", p, probs}` |
| `POST /api/checkout` | Tylin | Stephen (shop, agent) | body `{listingId, amountUsd, transientTokenJwt?}` + TAP headers → `{dealId, status:"HELD", authId}` |
| `POST /api/pickup` | Tylin | Stephen (pickup, kiosk, mobile) | body `{dealId, label, photoB64?}` → `{status:"CAPTURED"\|"REVERSED"\|"HELD", verdict}` |
| `GET /api/stream` (SSE) | Tylin | Stephen (board) | `event: deal`, data = the full deal document |
| Deal document | Tylin | Stephen | `{_id, listingId, amountUsd, status, authId, captureId?, reversalId?, verdict?, passport?, holdUntil, history:[...]}` |
| `docs/FACTS.json` | Stephen | everyone | `{scanned, flagged, precisionReviewed, classifier:{macroF1, zeroShotMacroF1}, asOf}` |

**Contract changes require telling the other person before committing.** Mark such commits with
`⚠️ CONTRACT`.

---

## Decisions

### D1: Visa sandbox only, full-amount capture
Authorization with capture false, then a full capture or a reversal of the same amount. Partial capture
needs account enablement. **Locked 2026-09-25 by Stephen.**

### D2: Verdict vocabulary never says "safe"
Only the five `Verdict.kind` values. "No match in CPSC/NHTSA as of <date>" is the clean wording.
**Locked 2026-09-25.**

### D3: Legal rules the matcher enforces (verified 2026-09-25)
- Recalled products: illegal to sell, so `RECALL_MATCH`.
- Inclined sleepers and crib bumpers: banned regardless of manufacture date (mesh liners excepted), so
  `BANNED_TYPE`.
- Drop-side and pre-2011 cribs: cannot be resold, so `BANNED_TYPE`.
- In-bed sleepers: must meet the bassinet standard (stand required), so `NEEDS_CHECK`.
- Car seats: recall is `RECALL_MATCH`, otherwise `NEEDS_CHECK` plus the NHTSA used-seat checklist.

**Locked 2026-09-25.**

### D4: No mock data a judge can reach
Demo deals are real in-app listings of the real items on our table, labelled "pickup simulated with table
props". The recalled prop is a label printed from CPSC recall 26-061, labelled as such.
**Locked 2026-09-25.**

### D5: Hardware is plug-in only
The ACR122U NFC reader, the USB barcode scanner and the laptop screen and speaker for red/green + buzzer.
No LilyPad wiring, no Raspberry Pi. **Locked 2026-09-25 by Stephen.**

### D6: Claim only what is live
Visa Intelligent Commerce, Click to Pay, 3DS and Decision Manager are gated; we claim each only if Visa
enables it. Webhooks are skipped (1-2 business day approval). **Locked 2026-09-25.**

---

## Open Questions

- [ ] **Q1:** Does Visa hand out Intelligent Commerce sandbox creds at the event? Ask at the Sat 10 AM
  workshop. Needs Stephen + Tylin.
- [ ] **Q2:** Which Gemini model ID is live today? List models at H0 and pin it in `label.ts`. Needs
  Stephen.
- [ ] **Q3:** Does the Visa Acceptance Test Business Center show our sandbox transactions in Transaction
  Search (for a portal still in the video)? Needs Tylin.

---

## Hard Rules

1. No em dashes anywhere judge-facing: README, UI copy, Devpost, video.
2. Stage named paths only. Never `git add -A`.
3. CI gates run bare. A skipped test is a false green.
4. Commit format: `type(scope): description`. Status updates: `status: <task#> <emoji> <description>`.
   Never bundle a status change with code.
5. Secrets never in git: `.env.local` only, plus Vercel and GitHub secrets.
6. Every number in the README, `/judge`, the video or Devpost comes from `docs/FACTS.json`.

_Last updated: 2026-09-26 05:55 ET by Stephen (Claude)._
