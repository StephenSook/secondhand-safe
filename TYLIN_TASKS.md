# Tylin Tasks

Personal task view. Source of truth is `PLAN.md` (statuses, contracts, open PRs). Updated Sat Sep 26, 4:45 PM.

Legend: [ ] not started · [-] in progress · [x] done · [!] blocked on a person

---

## Read this first

The product is **Lullabuy** (repo name stays `secondhand-safe`). Live at **https://lullabuy.tech** (also
https://secondhand-safe-web.vercel.app). `git pull` before anything.

Your role for judging (Sun 9:30-11 AM): **you own the "how does it work" questions** while Stephen owns the
story, the product and the business case. Stephen has a 34-page technical guide written for you
(`Lullabuy-Technical-Guide-Tylin.pdf`, on his Desktop; he will AirDrop it). It is not in the repo on purpose:
it has our judge Q&A prep.

Everything below the "Done" list is live and tested. You do not need to build anything to be ready.

---

## Before the expo (in this order)

### A. The one build unlock only you can do (do it FIRST, tonight)

- [!] **T6. Visa Developer Platform account + sandbox project with Visa Direct (Push Funds).** Account
  creation is a human step (Claude may not create accounts). Go to https://developer.visa.com, sign up,
  create a project, add **Visa Direct** (and **Visa Payment Passkey** if the project wizard offers it).
  Tell Stephen the moment the project exists: the CSR, the two-way SSL cert and the payout code are done on
  his side. This is the **only missing Visa journey stage** (seller payout after capture, PLAN 3.17 / H1).
  Visa's own staff pointed participants to developer.visa.com at this event, so it is the expected path.
- [ ] **T7. Your own Visa Acceptance sandbox keys** in `.env.local` (`VISA_MERCHANT_ID`, `VISA_KEY_ID`,
  `VISA_SECRET_KEY`), AirDropped to Stephen, so our test transactions show in YOUR Business Center and the
  video can show Visa's own portal (PLAN Q3). Today the site uses Cybersource's public sample merchant.

### B. Verify the product works (this is what makes it "complete" from your side)

- [ ] **T2. Walk the judge path on your own phone:** https://lullabuy.tech/judge, every step. Note anything
  slow, confusing or broken in the team chat with the step number. Also open on the phone:
  `/shop` (type AND talk to the voice agent), `/pickup` (real camera scan), `/board`, `/trust`, `/watch`.
- [ ] **T3. Run the demo twice at the table** with Stephen, from a phone, on lullabuy.tech (not localhost):
  - Deal 1: hold $64 on the Harppa high chair, scan the printed CPSC 26-061 label: **REVERSED**.
  - Deal 2: hold on the real item, scan its label: **CAPTURED**, then open the Solana passport link.
  - Show `/board` updating live (seller QR view) and `/trust`.
  - `/watch`: simulate a recall for the model you just captured; the sale shows as affected.
- [ ] **T8. Review PR #40 (Solana passport as a Metaplex Core asset)**: it touches the pickup route. Read
  the diff, check the three things a backend owner would: one mint per deal (`passport_mints`), the daily
  cap fails closed, and pickup never waits on the chain. Approve or comment. Do not merge; merge rule is in
  PLAN.md "Open pull requests".
- [ ] **T9. Break it on purpose (10 minutes, read-only, production is fine):**
  - replay a used pickup token: expect `REFUSED`, never a second capture;
  - `curl -s -X POST https://lullabuy.tech/api/agent/checkout -H 'content-type: application/json' -d '{}'`:
    expect a refusal, no hold;
  - `curl -s https://lullabuy.tech/api/health`: every integration you expect is `true`.
  Report anything that surprises you.

### C. Be ready to answer

- [ ] **T1. Read the technical guide** (34 pages) and the 40 judge questions at the end. Mark any answer you
  would not be comfortable defending and tell Stephen.
- [ ] **T4. Know the three commands** a technical judge may ask for (they work from any laptop):
  - `curl "https://lullabuy.tech/api/check?model=BHC001&batch=202408"` (recall match, live)
  - `curl https://lullabuy.tech/api/health` (every integration true/false, read from server config)
  - MCP: `{"mcpServers":{"lullabuy":{"type":"http","url":"https://lullabuy.tech/api/mcp"}}}`
- [ ] **T10. Devpost:** accept Stephen's team invite on the Lullabuy project (he adds you), confirm your
  name and school (University of Georgia) show on the project page.
- [x] T5. ~~Review PR #27 and #32~~: both merged and deployed after their review rounds.

---

## Run it locally (optional)

```bash
git pull && npm ci
# get .env.local from Stephen by AirDrop (never Discord, never git)
npm run dev          # http://localhost:3000
npx vitest run       # unit tests (live tests skip without keys)
npm run lint && npx tsc --noEmit
```

Deploys are manual: see PLAN.md, "Open pull requests" section, for the exact safe steps.

---

## Done (all live and in CI)

- [x] Visa Acceptance sandbox hold: authorize with capture off, capture or reverse at pickup (`src/server/visa/**`,
  `src/app/api/{checkout,pickup}`), Microform card entry, Token Management Service saved card, card-linked
  promotions, over-authorization reversal, rate limit on unsigned checkouts.
- [x] Trusted Agent Protocol (RFC 9421, Ed25519) agent checkout + tamper refusal (`src/server/tap/**`).
- [x] Recall index: 1,208 CPSC + NHTSA recalls, matcher with batch and date rules (`data/`, `src/server/recalls/`).
- [x] Deal token (HMAC) so pickup can only settle its own hold for its own amount.
- [x] Hold sweeper: daily Vercel cron releases holds older than 24 h (`src/server/deals/sweep.ts`).
- [x] MongoDB Atlas: deal store, `/board`, seller live view `/deal/[id]`, `/trust` console.
- [x] Solana devnet passport (Memo) with a public verifier page `/passport/[sig]`.
- [x] Gemini label reader, keyless (Vercel OIDC to Google Cloud Workload Identity Federation).
- [x] On-device CLIP classifier (trained head beats zero-shot; numbers in `docs/FACTS.json`).
- [x] ElevenLabs spoken verdicts (EN/ES); MCP server `recall_check`; live probe every 30 min on both origins.
- [x] Mobile: Expo app (Shop, Scan, Board); Android APK on the GitHub Release `mobile-v1.0.0`.
- [x] ElevenLabs conversational voice agent on `/shop` (PR #27) + one-open-hold guard per tab.
- [x] Atlas Vector Search look-alike (PR #32): held-out right recall first 60/144, top-3 68/144.
- [x] Recall watch (PR #37): daily re-check of captured sales, web push, `/watch` simulation.
- [x] Live board over an Atlas change stream (PR #38): `/api/stream` SSE, polling fallback.

## In review (do not edit these files without telling Stephen)

- [-] PR #40: Solana passport as a Metaplex Core asset (`src/server/solana/{core,meta}.ts`,
  `src/app/api/pickup/route.ts`, `src/app/api/cron/watch/route.ts`). Codex round 1 found 4 issues, all fixed;
  round 2 running.

---

## Hard rules
1. No em dashes in anything a judge reads.
2. Stage named paths only. Never `git add -A`.
3. Read CI results before merging, in a separate step. A skipped test is a false green.
4. Never commit or paste a key. `.env.local` moves by AirDrop only.
5. Never say the product makes an item "safe". Say "no recall match as of <date>".
