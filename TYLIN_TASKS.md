# Tylin Tasks

Personal task view. Source of truth is `PLAN.md` (statuses, contracts, open PRs). Updated Sat Sep 26, 3:40 PM.

Legend: [ ] not started · [-] in progress · [x] done · [!] blocked on a person

---

## Read this first

The product is **Lullabuy** (repo name stays `secondhand-safe`). Live at **https://lullabuy.tech** (also
https://secondhand-safe-web.vercel.app). `git pull` before anything.

Your role for judging (Sun 9:30-11 AM): **you own the "how does it work" questions** while Stephen owns the
story, the product and the business case. Stephen has a 31-page technical guide written for you
(`Lullabuy-Technical-Guide-Tylin.pdf`, on his Desktop; he will AirDrop it). It is not in the repo on purpose:
it has our judge Q&A prep.

Everything below the "Done" list is live and tested. You do not need to build anything to be ready.

---

## Before the expo (in this order)

- [ ] **T1. Read the technical guide** and the 32 judge questions at the end. Mark any answer you would not
  be comfortable defending and tell Stephen.
- [ ] **T2. Walk the judge path yourself on your phone:** https://lullabuy.tech/judge, every step. Note
  anything slow, confusing or broken in the team chat (with the step number).
- [ ] **T3. Run the demo twice at the table** with Stephen:
  - Deal 1: hold $64 on the Harppa high chair, scan the printed CPSC 26-061 label: **REVERSED**.
  - Deal 2: hold on the real item, scan its label: **CAPTURED**, then open the Solana passport link.
  - Show `/board` (seller QR view) and `/trust` (Trust and Safety console).
- [ ] **T4. Know the three commands** a technical judge may ask for (they work from any laptop):
  - `curl "https://lullabuy.tech/api/check?model=BHC001&batch=202408"` (recall match, live)
  - `curl https://lullabuy.tech/api/health` (every integration true/false, read from server config)
  - MCP: `{"mcpServers":{"lullabuy":{"type":"http","url":"https://lullabuy.tech/api/mcp"}}}`
- [ ] **T5. Review PR #27 (voice agent) and PR #32 (Atlas look-alike)** on GitHub: read the diff, leave an
  approval or a comment. Merge rule is in PLAN.md "Open pull requests".
- [!] **T6. Visa Developer Platform account + sandbox project with Visa Direct (Push Funds).** Account
  creation is a human step. Once the project exists, tell Stephen; the CSR, cert and code are done on his
  side. Unlocks seller payout (PLAN 3.17 / H1). Skip if short on time: it is not needed for the demo.
- [ ] **T7. Optional:** your own Visa sandbox keys in `.env.local` (`VISA_MERCHANT_ID`, `VISA_KEY_ID`,
  `VISA_SECRET_KEY`) so our test transactions show in YOUR Business Center (PLAN open question Q3). The live
  site uses Cybersource's public sandbox merchant today.

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

## In review (do not edit these files without telling Stephen)

- [-] PR #27: ElevenLabs conversational voice agent + one-open-hold guard (`src/ui/{VoiceAgent,ShopAgent}.tsx`,
  `src/app/api/voice-agent/**`, `src/app/api/{checkout,agent/checkout}/route.ts`).
- [-] PR #32: Atlas Vector Search look-alike (`src/server/db/vector.ts`, `src/app/api/lookalike`, `/pickup` card).

---

## Hard rules
1. No em dashes in anything a judge reads.
2. Stage named paths only. Never `git add -A`.
3. Read CI results before merging, in a separate step. A skipped test is a false green.
4. Never commit or paste a key. `.env.local` moves by AirDrop only.
5. Never say the product makes an item "safe". Say "no recall match as of <date>".
