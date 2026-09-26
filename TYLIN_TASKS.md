# Tylin Tasks

Personal task tracker. Source of truth is `PLAN.md`; this file is a convenience view only. The code-level
steps for each task are in `docs/IMPLEMENTATION.md`.

Legend: [ ] not started · [-] in progress · [x] done · [!] blocked

---

## Keys to gather (you sign up yourself; values go in `.env.local`, never in git)

| Name | Where you get it | What it unblocks |
|---|---|---|
| `VISA_MERCHANT_ID`, `VISA_KEY_ID`, `VISA_SECRET_KEY` | developer.visaacceptance.com, sandbox sign-up, then Test Business Center, REST shared-secret key | 0.6 live auth/capture/reversal, 1.5, 2.4 |
| Visa Developer project (Visa Direct + Payment Passkey) | developer.visa.com, new project; Visa generates the two-way SSL cert | 2.5 |
| Visa Intelligent Commerce | developer.visa.com "Request Access" + developer.visaacceptance.com agentic sandbox sign-up | claimed only if granted |
| `MONGODB_URI` | MongoDB Atlas M0 (mlh.link/mongodb for the $50 student credit); invite Stephen to the project | 1.2, 1.4, everything |
| `TAP_AGENT_PRIVATE_KEY_HEX`, `TAP_AGENT_KEY_ID` | generate locally (ed25519) | 1.1 |
| `SOLANA_SECRET_KEY_B58` | devnet keypair + faucet.solana.com (2 requests / 8 h; GitHub login raises it) | 2.3 |
| GitHub Actions secrets | the same `VISA_*` + `MONGODB_URI`, set on this repo | the CI live tests |

Keys move to Stephen by AirDrop of `.env.local`, never Discord.

---

## Lane ownership

Files you own exclusively:
- `src/server/**` (except `src/server/ml/**` and `src/server/voice/**`)
- `src/core/**`
- `src/app/api/**` (except `src/app/api/agent/**`)
- `data/**`
- `.github/workflows/**`
- `tests/` for your modules

---

## Phase 0: Scaffold (Fri 11 PM to Sat 2 AM)
- [ ] **0.2** Next.js scaffold in place + deps.
- [ ] **0.3** `src/server/env.ts` + test.
- [ ] **0.4** CI (lint, typecheck, vitest, pytest, build, gitleaks, em-dash gate), every gate bare.
- [ ] **0.5** Your keys (table above).
- [ ] **0.6** **GATE:** live sandbox auth → capture, auth → reversal.

## Phase 1: Core loop (Sat 12 AM to 6 AM)
- [ ] **1.1** TAP sign/verify + tamper tests.
- [ ] **1.2** Recall index (CPSC + NHTSA) into Atlas + a 20-record hand check.
- [ ] **1.3** Verdict rules + fuzzy matcher.
- [ ] **1.4** Atlas indexes + change stream SSE.
- [ ] **1.5** Deal state machine + `/api/checkout` + `/api/pickup` + sweeper.

## Phase 2: Deploy + depth (Sat 6 AM to 2 PM)
- [ ] **2.1** Vercel deploy + e2e + probe (keep it ON through judging).
- [ ] **2.2** `/api/check`, `/api/stats`, `/api/health`.
- [ ] **2.3** Solana passport + memo.
- [ ] **2.4** Microform + TMS.
- [ ] **2.5** Visa Direct + Payment Passkey.
- [ ] **2.6** Recall watch + web push.

## Phase 3-4
- [ ] **3.3** MCP `recall_check` server.
- [ ] **3.5** Codex adversarial rounds until clean.
- [ ] **4.1** Claims audit + gitleaks.
- [ ] **4.5** Post-merge main CI verified on the SHA.

---

## Hard rules
1. No em dashes in judge-facing text.
2. Stage named paths only. Never `git add -A`.
3. CI gates run bare; a skipped test is a false green.
4. Status commits are separate from code commits.
