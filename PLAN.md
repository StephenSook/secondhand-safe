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
| 0.5 | Accounts + keys (each person signs up themselves, keys move by AirDrop only) | local `.env.local` | **Tylin**: Visa Acceptance sandbox, Visa Developer project (Visa Direct + Payment Passkey), Atlas M0. **Stephen**: Gemini, ElevenLabs + .Tech (MLH email), eBay keyset, Vercel, Solana devnet wallet, Notability QR, HexLabs OpenAI key | 🟡 | n/a | DONE: Visa sandbox, TAP, ElevenLabs, Atlas M0 'lullabuy', Solana devnet wallet (1 SOL), keyless Gemini (Vercel OIDC -> WIF -> Vertex), .Tech domain lullabuy.tech (auto-renew OFF), Notability Pro (HACKGT, renewal cancelled, ends Oct 26). OPEN, human only: VDP project (H1). |
| 0.6 | **Gate:** sandbox auth → capture, and auth → reversal, from a live test | `src/server/visa/acceptance.ts`, `tests/visa.live.test.ts` | **Stephen** | ✅ | 0.3, 0.5 | Live: AUTHORIZED -> capture PENDING, AUTHORIZED -> REVERSED (tests/visa.live.test.ts) on Cybersource's PUBLIC sample merchant 'testrest'. Tylin: swap in your own sandbox keys so transactions show in your Business Center. $40.00 is a simulator AVS trigger. | |

### Phase 1: Core loop (Sat 12 AM to 6 AM)

| # | Component | File(s) | Owner | Status | Deps | Notes |
|---|---|---|---|---|---|---|
| 1.1 | Trusted Agent Protocol sign + verify + tamper tests | `src/server/tap/tap.ts`, `tests/tap.test.ts` | **Stephen** | ✅ | 0.3 | Merged PR #10 + review fixes (signature before nonce, capped nonce, identity+integrity wording, $200 agent cap). Prod needs TAP key pushed. | | | |
| 1.2 | Recall index: CPSC + NHTSA → Atlas, with a 20-record hand check | `data/build_recall_index.py`, `data/handcheck.md` | **Stephen** | ✅ | 0.5 | 6,036 CPSC recalls -> 1,137 nursery. Gemini 3.5 Flash pass (Vertex, Sat 8 AM): 449 -> 822 with identifiers, values kept only if verbatim in the recall. Short numeric models need the brand. data/handcheck.md. | |
| 1.3 | Verdict rules + fuzzy matcher (O/0, I/1 folding) | `src/core/verdict.ts`, `src/server/recalls/match.ts` | **Stephen** | ✅ | 1.2 | src/server/recalls/match.ts + tests: folding, batch rule (26-061 recalls BHC001 only in batch 202408), D3 rules, junk-id guard. | |
| 1.4 | Atlas indexes + change stream → `/api/stream` (SSE) | `src/server/db/mongo.ts`, `src/app/api/stream/route.ts` | **Tylin** | 🟡 | 0.5 | Atlas deals live; board refreshes every 3 s from /api/deals. A change-stream push (5.3) is not built. |
| 1.5 | Deal state machine + `/api/checkout` + `/api/pickup` + hold sweeper | `src/server/deals/machine.ts`, `src/app/api/{checkout,pickup,cron}/**` | **Stephen** | ✅ | 0.6, 1.1, 1.3 | Deal token + settle + hold sweeper (5.4) done. |
| 1.6 | Listing harvest (1,000+ real listings, eBay + Craigslist Atlanta) | `ml/harvest.py` | **Stephen** | ✅ | 0.5 | 1,662 listings (613 Craigslist, 1,049 eBay) + 243 CPSC photos, contact info redacted. Loads into Atlas `listings` once 0.5 exists. Finding: eBay already filters bumpers and Rock 'n Plays. |
| 1.7 | Classifier dataset + training + eval vs zero-shot | `ml/embed.py`, `ml/train.py`, `ml/eval.py`, `ml/labels.csv` | **Stephen** | ✅ | 1.6 | Head now trained on transformers.js q8 embeddings (the phone runtime). Held-out macro-F1 0.724 [0.60, 0.81] vs 0.558 zero-shot; 2/107 vs 38/107 false alarms. Numbers live in docs/FACTS.json. | |
| 1.8 | Label reader: Gemini vision JSON + boxes, OpenAI fallback | `src/server/ml/label.ts`, `tests/label.live.test.ts` | **Stephen** | ✅ | 0.5 | Live via Vertex on a real CPSC label photo (KMART 07-1248 -> recall 11020, tests/label.live.test.ts). Prod needs a Gemini key on a funded project (see 0.5). | |
| 1.9 | Pickup page with live scan overlay + upload fallback | `src/app/pickup/**`, `src/ui/ScanOverlay.tsx` | **Stephen** | ✅ | 1.8 | /pickup: photo, BarcodeDetector UPC, Gemini label, on-device classifier, editable fields, real hold settlement, spoken verdict. | |
| 1.10 | Deal Board (glass card per deal, live via SSE) | `src/app/board/**`, `src/ui/GlassDealCard.tsx` | **Stephen** | ✅ | 1.4 | /board reads Atlas (polling every 3 s). Push via change stream is 5.3. |

**CHECKPOINT Sat 6 AM:** both demo deals work end to end on localhost (Deal 1 REVERSED on the printed
26-061 label, Deal 2 CAPTURED on the real item). If not, stop and fix together before anything in Phase 2.

### Phase 2: Deploy + depth (Sat 6 AM to 2 PM)

| # | Component | File(s) | Owner | Status | Deps | Notes |
|---|---|---|---|---|---|---|
| 2.1 | Vercel deploy (dedicated project `secondhand-safe-web`) + CI e2e + live probe | `.github/workflows/probe.yml` | **Stephen** | ✅ | 1.5 | https://secondhand-safe-web.vercel.app; vercel.json pins nextjs; probe.yml every 30 min asserts real verdicts. Playwright suite passes against production. | |
| 2.2 | Public `/api/check`, `/api/stats`, `/api/health` | `src/app/api/{check,stats,health}/**` | **Stephen** | ✅ | 1.3 | /api/check (GET for curl, POST), /api/stats, /api/health, all from artifacts. | |
| 2.3 | Solana passport (Metaplex Core) + memo anchor | `src/server/solana/passport.ts` | **Tylin** | ✅ | 1.5 | Memo passport live (see 3.12). Metaplex Core asset upgrade is 5.7. |
| 2.4 | Microform card entry + TMS token | `src/server/visa/acceptance.ts` | **Tylin** | ✅ | 0.6 | Done as 3.9 (Microform) + 3.16 (TMS). |
| 2.5 | Visa Direct push funds to seller + Visa Payment Passkey step-up | `src/server/visa/direct.ts` | **Tylin** | ⛔ | 0.5 | Same as 3.17: needs the VDP project (H1). |
| 2.6 | Recall watch (Atlas trigger) + web push | `src/server/watch/**` | **Tylin** | ⬜ | 2.3 | Merged into 5.5 (recall watch + push). |
| 2.7 | Shop page + Gemini agent (search, prescreen, TAP-signed checkout) | `src/app/(shop)/**`, `src/server/ml/agent.ts` | **Stephen** | ✅ | 1.3, 1.1 | /shop: Gemini 3.5 Flash parses the request (typed or spoken) into filters over 1,662 real scanned listings; every result pre-screened (recall index + photo model + human review); red refused server-side; TAP-signed agent hold hands off to /pickup. Two review rounds fixed. |
| 2.8 | Classifier runtime in Node (CLIP + trained head, parity test with Python) | `src/server/ml/classify.ts`, `public/models/head.json` | **Stephen** | ✅ | 1.7 | In-browser CLIP q8 + head.json; parity suite in CI: head math = sklearn to 1e-5; cross-platform q8 cosine 0.987 to 0.996, same class. | |
| 2.9 | Measured scan of all harvested listings + hand review of red flags | `ml/scan.py`, `ml/review.csv`, `docs/FACTS.json` | **Stephen** | ✅ | 1.6, 1.7, 1.3 | 1,662 listings scanned. Round 1: 39 flags, 1 real (reviewed by eye). 23 false alarms -> train-only hard negatives -> round 2: 9 flags. HONEST: X of N is tiny on eBay/Craigslist (matches CR's 7/400, 2/49); lead with CR's 50/65 + the learning loop instead. | |
| 2.10 | Checkpoint kiosk (barcode + camera) + NFC bridge for the ACR122U | `src/app/checkpoint/**`, `bridge/index.mjs` | **Stephen** | ⬜ | 1.5 | Kiosk page is 5.12; NFC needs the reader in hand (H5). |
| 2.11 | ElevenLabs spoken verdict (EN + ES) + voice agent | `src/server/voice/elevenlabs.ts` | **Stephen** | ✅ | 1.5 | TTS verdict + result summary EN/ES live. Conversational agent is 5.6. |
| 2.12 | Visa workshop, Klaus 1443 (Sat 10-11 AM). Ask: who judges, VIC creds, the hold mechanic | n/a | **Stephen + Tylin** | ⬜ | n/a | Past (Sat 10-11 AM). Stephen: did anyone attend? Record what Visa said here. |

### Phase 3: Galaxy tier + hardening (Sat 2 PM to 9 PM)

| # | Component | File(s) | Owner | Status | Deps | Notes |
|---|---|---|---|---|---|---|
| 3.1 | Expo iOS pickup scanner (on-device OCR) | `mobile/**` | **Stephen** | ✅ | 1.5 | Duplicate of 3.14. |
| 3.2 | `/map` (deck.gl hex), `/atlas` (embedding-atlas), `/trust` (T&S console), `/judge`, `/passport/[id]` | `src/app/**` | **Stephen** | 🟡 | 2.9 | /judge, /map, /atlas, /passport done. /trust console is 5.8. |
| 3.3 | MCP server `recall_check` for AI shopping agents (HTTP) | `src/app/api/mcp/route.ts` | **Stephen** (took over) | ✅ | 2.2 | /api/mcp, stateless Streamable HTTP, read-only recall_check; curl + config in README; tests/mcp.test.ts. |
| 3.4 | FACTS test: README, `/judge`, submission numbers equal `docs/FACTS.json` | `tests/facts.test.ts` | **Stephen** | ✅ | 2.9 | tests/facts.test.ts: README numbers == docs/FACTS.json. | |
| 3.5 | Codex adversarial review of payments + TAP + matcher, repeated until a clean round | n/a | **Tylin** | 🟡 | 1.5 | Codex out of quota until Sep 30, Gemini + Grok 402. Fresh-context Claude reviewers ran on every money-path diff (Microform, matcher, shop, passport, Atlas, TMS). New diffs: 5.14. |
| 3.6 | Stills of every judge page (desktop + phone) from the deployed origin | `docs/stills/` | **Stephen** | 🟡 | 2.1 | Re-run after round 3 (5.13). |
| 3.7 | Tier 3 (only once Phase 1-2 are ✅ on main): Vultr inference, Tiger Data trend, Backboard memory, YOLO label finder, Apple Wallet pass, USDC payout | various | split | ⬜ | Phase 2 | Split into 5.x rows and H2-H4. |
| 3.8 | Aardvark-style motion system + art (design study docs/design/aardvark-reference.md) | `src/ui/**`, `public/art/**` | **Stephen** | ✅ | n/a | Preloader stroke wipe, elastic words, fanned cards, pinned scroll-scrub scan (generated, captioned), floating gear, parallax footer. |
| 3.9 | Microform card entry (replaces the server-side sandbox test card) | `src/server/visa/microform.ts`, `/pickup` | **Stephen** (took over) | ✅ | 0.6 | Visa Microform v2 fields, transient token into authorize(); live e2e green; review round 1 fixed (loading guard, card source on the hold, expiry, origin, rate limit). |
| 3.10 | TAP-signed agent checkout (RFC 9421 ed25519) + tamper demo | `src/server/tap/**` | **Stephen** | ✅ | 1.5 | Same as 1.1. | | | |
| 3.11 | Atlas: recalls + deals + listings, change stream -> Deal Board | `src/server/db/**`, `/board` | **Tylin** (DB) + **Stephen** (board) | ✅ | 0.5 | Atlas M0 "lullabuy": deals recorded via waitUntil; /board; e2e seller.spec on prod. |
| 3.12 | Solana devnet passport + memo of the verification hash | `src/server/solana/**` | **Stephen** (took over) | ✅ | 1.5 | Live: devnet wallet funded (faucet, Stephen GitHub auth); capture writes a Memo passport; /passport verifies signer + success + hash; e2e passport.spec on prod. | |
| 3.13 | NHTSA child-seat recalls into the index | `data/build_recall_index.py` | **Stephen** | ✅ | 1.2 | 71 NHTSA child-restraint campaigns with manufacture date ranges; date rule in the matcher (PR #8). | |
| 3.14 | Expo iOS pickup scanner | `mobile/**` | **Stephen** | ✅ | 1.9 | Expo SDK 57 app (mobile/): Shop, Scan label, Deal board on the live API; verified in the iOS 26 simulator; CI mobile job. Phone: Expo Go + `npx expo start`. |
| 3.15 | Seller-side confirmation of the pickup scan (today the buyer's device reports it; review finding) | `/pickup`, `src/app/api/pickup/**` | **Tylin** + **Stephen** | ✅ | 1.5 | Seller live view /deal/<id> via QR on the buyer pickup screen (reads Atlas every 3 s). The buyer device still reports the scan; noted in Q&A. |
| 3.16 | Visa Token Management Service: save the card as a token at authorization (TOKEN_CREATE) and reuse it | `src/server/visa/**` | **Stephen** | ✅ | 3.9 | Visa TMS saved card (signed wrapper, 7-day life) + Visa card-linked promotions handled (measured live: 20% off, no status field); e2e savedcard.spec on prod. |
| 3.17 | Visa Direct push payout to the seller after capture | `src/server/visa/**` | **Tylin** | ⛔ | 1.5 | BLOCKED: needs a Visa Developer Platform project + two-way SSL cert (account creation is a human step). |
| 3.18 | MLH extras: Tiger Data (scan trend hypertable), Backboard (parent memory), Vultr (inference box) | various | split | ⛔ | 3.11 | Tiger Data (H2), Backboard (H3), Vultr (H4): accounts are human steps. |
| 3.19 | YOLO label finder (box the label, then crop for Gemini) | `ml/**` | **Stephen** | ⬜ | 1.8 | Now 5.10. |
| 3.20 | Physical Pickup Checkpoint (Circuit Playground ring/buzzer, barcode scanner, NFC sticker) | `hardware/**` | **Stephen** | ⛔ | 1.9 | Needs the parts (H5). D5: plug-in only. |
| 3.21 | Recall watch: re-check stored deals when a new recall lands, notify the owner | `src/server/**` | **Stephen** | ⬜ | 3.11 | Now 5.5. |

### Phase 5: Galaxy round 3 (Sat 1:30 PM onward, built by Claude on Stephen's side)

| # | Component | File(s) | Owner | Status | Deps | Notes |
|---|---|---|---|---|---|---|
| 5.1 | Live probe: red since the rebrand (it grepped the old name); now both origins + Atlas deals + MCP | `.github/workflows/probe.yml` | **Stephen** | ✅ | n/a | PR #24 merged; both origins green (verified by hand and in Actions). |
| 5.2 | Atlas Vector Search: "this photo looks like recalled product X" over the 243 CPSC recall photos + listing photos (CLIP, 512-d) | `src/server/db/vector.ts`, `/pickup`, `/shop` | **Stephen** | ✅ | 3.11 | PR #32 merged + deployed; verified live (POST embedding and GET ?listingId=). Held-out eval: right recall first 60/144 (41.7%), top-3 68/144 (47.2%), reproducible (ml/sample_second_photos.py + scripts/eval-lookalike.mjs). Reviewed by Claude + Grok. Resemblance never flags anything. |
| 5.3 | Change stream -> `/api/stream` SSE -> live `/board` | `src/app/api/stream/route.ts` | **Stephen** | ✅ | 3.11 | Done as 6.3 (PR #38). |
| 5.4 | Hold sweeper: Vercel cron reverses holds past their window; the board shows RELEASED | `src/app/api/cron/**`, `vercel.json` | **Stephen** | ✅ | 1.5 | PR #28 merged + deployed. Daily Vercel cron 13:17 UTC (9:17 AM ET). 3 review rounds (Claude x2, Grok). Verified live: 401 without CRON_SECRET, 200 with it. |
| 5.5 | Recall watch: a new recall re-checks every stored deal + passport, marks "recalled after sale", web push to the owner (VAPID) | `src/server/watch/**`, `public/sw.js` | **Stephen** | ✅ | 3.11, 3.12 | Done as 6.2 (PR #37). CORRECTION 4:45 PM: the shipped demo is a typed hypothetical model on /watch (e.g. ZZT9Q41X), not a replay of 26-568; the 26-568 replay is row 6.12. |
| 5.6 | ElevenLabs conversational shopping agent (Agents Platform) with a server tool calling `/api/shop`, EN + ES | `src/ui/VoiceAgent.tsx`, `scripts/elevenlabs-agent.mjs` | **Stephen** | ✅ | 2.7 | PR #27 merged + deployed. 10 Codex rounds; live: signed session URL for our pages, 403 cross-site, webhook 200 with the secret and 401 without. |
| 5.7 | Solana passport as a Metaplex Core asset with Attributes (verdict, index date, record hash), updated on recall | `src/server/solana/**` | **Stephen** | 🟡 | 3.12 | Same as 6.4 (PR #40). |
| 5.8 | `/trust` Trust and Safety console: reversals by reason, disputes avoided, flag trend, drawn with Visa Chart Components | `src/app/trust/**` | **Stephen** | ✅ | 5.3 | PR #30 merged + deployed: /trust and /api/trust, live from Atlas, says plainly the deals are our demos and e2e tests. |
| 5.9 | "Without vs With" replay: the same deal on a cash marketplace vs a held Visa payment | `src/app/board/**` | **Stephen** | ⬜ | 5.3 | Not started. |
| 5.10 | Second trained model: YOLO label finder (box the label, crop, then read); report read rate with and without it | `ml/**` | **Stephen** | ⬜ | 1.8 | Not started. |
| 5.11 | Claims audit: every named product grepped in shipped code; `.env.example` parity; gitleaks over full history | `docs/claims-audit.md` | **Stephen** | 🟡 | all | README status + submission draft brought in line with /api/health (PR #31). Full claims audit still to run before submit. |
| 5.12 | `/checkpoint` table kiosk: big verdict, keyboard-wedge barcode input, a sound per state; NFC if the reader arrives | `src/app/checkpoint/**` | **Stephen** | ⬜ | 1.9 | Not started (hardware not collected). |
| 5.13 | Stills of every judge screen (desktop + phone) from lullabuy.tech, each looked at | `docs/stills/` | **Stephen** | ⬜ | 5.2-5.12 | After #27 and #32 merge. |
| 5.14 | Adversarial review of every new diff, repeated until a clean round | n/a | **Stephen** | 🟡 | each | Every merged money-path diff had 2-3 adversarial rounds (Claude, Codex, Grok). |
| 5.15 | Devpost project drafted through the Devpost connector, NOT submitted | n/a | **Stephen** | ⬜ | 5.11 | Stephen presses submit; draft is docs/submission-draft.md. |
| 5.16 | Demo video (after 5.1-5.14; loudness + duration measured) | `docs/video/` | **Stephen** | ⬜ | 5.13 | Held until the product is complete (Stephen). |
| 5.17 | EAS builds: iOS store build (TestFlight-ready), iOS simulator build, Android APK | `mobile/eas.json` | **Stephen** | ✅ | 3.14 | PR #26. APK on GitHub Release mobile-v1.0.0 (verified download). Simulator build launched and loaded live deals. TestFlight upload is a separate step. |
| 5.18 | Rate limit on unsigned /api/checkout (20/min per IP, per instance) | `src/app/api/checkout/route.ts` | **Stephen** | ✅ | 1.5 | PR #31. Measured live: 28 of 60 rapid calls refused; the limit is per server instance, so treat it as a speed bump. |
| 5.19 | Self-hosted fonts (build no longer downloads Google Fonts) | `src/app/fonts/**` | **Stephen** | ✅ | n/a | PR #29. A font download flake had turned main red; production verified serving the 3 local WOFF2 files. |

### Phase 6: Galaxy round 4 (Sat 3:30 PM onward, in this order; Claude builds, Stephen does the H rows)

| # | Component | File(s) | Owner | Status | Deps | Notes |
|---|---|---|---|---|---|---|
| 6.1 | Merge the voice agent (#27) after a clean review round; prove it end to end with ElevenLabs' simulated conversation (the agent calls our live webhook) | `src/ui/VoiceAgent.tsx` | **Stephen** | ✅ | 5.6 | Merged + deployed; verified live (see 5.6). |
| 6.2 | Recall watch: store the label fields at settlement; a labelled replay of a real CPSC recall re-checks every captured deal, marks "recalled after sale" on the deal, board, seller view and /trust, and pushes a notification to a subscribed browser | `src/server/watch/**`, `public/sw.js` | **Stephen** | ✅ | 3.11 | PR #37 merged + deployed (Grok review fixed: simulation counts only, only your own sale is notified, labels never public, failed pushes retried). Live: prod e2e captured 2 sales, simulate ZZT9Q41X -> 2 affected. |
| 6.3 | MongoDB change stream -> SSE -> /board updates the moment a deal changes | `src/app/api/stream/route.ts` | **Stephen** | ✅ | 3.11 | PR #38 merged + deployed: Atlas change stream -> SSE, polling fallback; live test: events in 30-280 ms, no Visa ids. |
| 6.4 | Solana passport as a Metaplex Core asset with on-chain Attributes, updated by the recall watch | `src/server/solana/**` | **Stephen** | 🟡 | 3.12 | PR #40, Sat 4:45 PM. Live devnet asset minted + updated. Codex round 1: 4 highs (wallet drain, orphaned mints, stale recall, cron budget), all fixed with tests (220/220, CI 7/7 on ec642c2). Codex round 2 running. Memo stays as the audit trail. |
| 6.5 | Server-side one-active-hold per buyer (signed browser id + atomic Atlas claim) and Atlas-backed rate limits (today both are per tab / per server instance) | `src/app/api/checkout/**` | **Stephen** | ⬜ | 1.5 | Money path: adversarial review before merge. |
| 6.6 | TestFlight upload of the signed iOS build | `mobile/**` | **Stephen** | ⛔ | H8 | Needs the App Store Connect app record (H8). |
| 6.7 | Second trained model: YOLO label finder (5.10) | `ml/**` | **Stephen** | ⬜ | 1.8 | |
| 6.8 | Refresh both PDFs + README known limits after 6.1-6.5 | `~/Desktop/*.pdf`, `README.md` | **Stephen** | 🟡 | 6.1 | PDFs refreshed 4:18 PM (product guide 25 p, Tylin guide 34 p, 40 Q&As). README known-limits paragraph (per-tab hold guard) still to write; re-render PDFs after #40 merges. |
| 6.9 | Stills of every judge screen, claims audit, Devpost draft through the Devpost connector (not submitted) | `docs/` | **Stephen** | ⬜ | 6.8 | Devpost draft exists (id 1445288); add voice agent, recall watch, live board, Core passport. |
| 6.10 | Our own WebAuthn passkey step-up at "Agree to buy" (a real browser passkey bound to the hold; NOT branded "Visa Payment Passkey", which needs VDP) | `src/app/api/passkey/**`, `/pickup`, `/shop` | **Stephen** | ⬜ | 1.5 | Money path: adversarial review before merge. |
| 6.11 | `/checkpoint` table kiosk without the hardware: full-screen verdict, keyboard-wedge barcode input (a USB scanner types like a keyboard, so it works the moment one is plugged in), a sound per state | `src/app/checkpoint/**` | **Stephen** | ⬜ | 1.9 | Same as 5.12; hardware (H5) becomes optional. |
| 6.12 | Recall-watch replay of a REAL recall: pick one CPSC recall whose model appears on a captured demo sale's label, replay it through the real daily path (labelled "replay"), show the push + board + passport flip | `src/server/watch/**`, `/watch` | **Stephen** | ⬜ | 6.2, 6.4 | Closes the 5.5 wording gap found by the PDF audit. |
| 6.13 | Look-alike data check: recall 26569 shows a Joolz title beside a CooCooBaby notice; audit title/notice/image alignment across all 243 recall photos and re-index | `ml/**`, Atlas `image_vectors` | **Stephen** | ⬜ | 5.2 | Found by the PDF writer 4:18 PM. A judge could see the mismatch. |
| 6.14 | "Without vs With" replay (5.9) | `src/app/board/**` | **Stephen** | ⬜ | 6.3 | |
| 6.15 | Visa Direct seller payout after capture (3.17) the moment Tylin's VDP project exists | `src/server/visa/direct.ts` | **Stephen** | ⛔ | H1 | Tylin T6. |

### Human-only steps (account creation, sign-ins, physical parts: Claude cannot do these)

| # | Step | Who | What it unlocks |
|---|---|---|---|
| H1 | Create a free Visa Developer Platform account + a sandbox project with Visa Direct (Push Funds). Claude then does the CSR, the cert and the code | **Tylin, tonight (TYLIN_TASKS T6)** | Seller payout after capture (3.17): the Visa "payments" stage end to end |
| H2 | Sign up for Tiger Data (Tiger Cloud free trial), AirDrop the connection string | Stephen | Scan-history hypertable + trend on /trust: MLH Tiger Data |
| H3 | Sign up for Backboard, AirDrop the API key | Stephen | The agent remembers the child's age and past buys: MLH Backboard |
| H4 | Vultr, only if the MLH credit works without a card on file | Stephen | GPU inference box: MLH Vultr |
| H5 | Hardware desk: USB barcode scanner, ACR122U NFC reader + stickers | Stephen | Table Checkpoint (5.12, 3.20) |
| H6 | One real parent's words, with consent | Stephen | Pitch + Devpost |
| H7 | Inspiration line, then final submit on Devpost AND expo.hexlabs.org | Stephen | Being judged at all |
| H8 | Create the app record in App Store Connect ("Lullabuy", bundle id tech.lullabuy.app, already registered). Apple does not allow creating it by API | Stephen | TestFlight upload (6.6): Claude uploads with the API key |
| H9 | Run `tiger auth login` in a terminal (Tiger Data account exists, its login token expired) | Stephen | Scan-trend hypertable on /trust: MLH Tiger Data |
| H10 | AirDrop `~/Desktop/Lullabuy-Technical-Guide-Tylin.pdf` to Tylin | Stephen | Tylin's expo prep (TYLIN_TASKS.md T1) |

### Phase 4: Freeze + submit (Sat 9 PM to Sun 8 AM)

| # | Component | File(s) | Owner | Status | Deps | Notes |
|---|---|---|---|---|---|---|
| 4.1 | Claims audit: grep the code for every named product; `.env.example` parity; gitleaks full history | `docs/claims-audit.md` | **Tylin** | ⬜ | all | Now 5.11 (runs again after every feature). |
| 4.2 | Demo video 2-3 min (loudness + duration measured) | `docs/video/` | **Stephen** | ⬜ | 3.6 | |
| 4.3 | Devpost writeup (Visa Acceptance + Trusted Agent Protocol named 3+ times, MongoDB Atlas, Solana), Notability note + 2 screenshots, .Tech domain | `docs/submission.md` | **Stephen** | 🟡 | 4.1 | docs/submission-draft.md: numbers from FACTS.json; TODOs for the parts only Stephen/Tylin can write (inspiration, what we learned). | |
| 4.4 | Submit to **Devpost AND expo.hexlabs.org**, every box checked, reload-verify both | n/a | **Stephen** | ⬜ | 4.3 | By Sun 6:30 AM. |
| 4.5 | Post-merge main CI verified on the merged SHA (count ≥ jobs, none failing) + probe green and young | n/a | **Tylin** | ⬜ | 4.4 | Never trust a `--watch` exit code. |

---

## Open pull requests (read before touching these files)

| PR | What | State | Merge rule |
|---|---|---|---|
| #40 | Solana passport as a Metaplex Core asset (6.4) | CI 7/7 green on ec642c2; Codex round 2 running | Merge only after a clean Codex round + per-SHA CI; then deploy and verify a live capture mints an asset |

Deploys are manual (no Git auto-deploy): from a clean `git worktree add --detach <dir> origin/main`, copy `.vercel/`,
check `projectName` is `secondhand-safe-web`, then `npx vercel --prod --yes`. Verify with the probe (both origins).

---

## Shared Contracts

| Contract | Owner | Consumers | Definition (read from the code, 2026-09-26) |
|---|---|---|---|
| `Verdict` | Tylin | Stephen (UI, voice, mobile) | `{kind: "RECALL_MATCH"\|"BANNED_TYPE"\|"NO_MATCH"\|"UNREADABLE"\|"NEEDS_CHECK", recall?, reason, asOf}` (`src/core/verdict.ts`) |
| `POST /api/checkout` | Tylin | Stephen (pickup, shop, agent) | body `{listing, amountUsd, transientTokenJwt? \| savedCard?, saveCard?}`, optional TAP signature headers. 200: `{dealId, listing, amountUsd, askedUsd?, promotion?, status:"HELD", card, visa:{authId,...}, token, at}`. Errors carry `placed:false` (no hold) or `uncertain:true` (a hold MAY exist). |
| `POST /api/agent/checkout` | Tylin | Stephen (shop, voice) | body `{listingId}` (catalog) or a demo-table item; signs with TAP and calls /api/checkout; returns `{merchant, request}`. Red listings refused. |
| `POST /api/pickup` | Tylin | Stephen (pickup, mobile) | body `{token, model?, batch?, date?, upc?, text?, cls?}` -> `{verdict, status:"CAPTURED"\|"REVERSED"\|"HELD"\|"REFUSED"\|"UNKNOWN", visa?, passport?}` |
| `GET /api/cron/sweep` | Tylin | Vercel Cron | `Authorization: Bearer $CRON_SECRET`; releases holds older than 24 h |
| `POST /api/lookalike` | Stephen | pickup, shop | `{embedding:number[512]}` or `?listingId=` -> `{matches:[{recallNumber,title,notice,image,cosine,strong}]}` (PR #32) |
| Deal record (Atlas `deals`) | Tylin | Stephen (board, seller view, trust) | `{_id: dealId, listing, amountUsd, status, card, agent, authId (server only, never public), createdAt, updatedAt, events[], verdict?, passportPath?, sweepAttemptAt?}` |
| `docs/FACTS.json` | Stephen | everyone | measured numbers; README, /judge and Devpost read from it |

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

- [x] **Q1:** Visa Intelligent Commerce: ANSWERED Sat 3:07 PM in #visa by Visa staff: "Unfortunately that is
  not a public platform". Never claim it (D6).
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

_Last updated: 2026-09-26 16:45 ET by Stephen (Claude). Tylin: start with TYLIN_TASKS.md._
