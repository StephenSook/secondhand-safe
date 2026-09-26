# SecondHand Safe: task-level implementation detail (TDD steps)

> Companion to `../PLAN.md`. Task numbers here are referenced from the PLAN.md status dashboard.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A used-baby-gear checkout where the buyer's Visa payment is authorized (held) at agreement and is
captured only after a camera and barcode check at pickup finds no CPSC/NHTSA recall and no banned product
type. Otherwise the authorization is reversed.

**Architecture:**
- One Next.js app on Vercel serves the PWA, the big-screen boards and all API routes.
  - Tylin owns `src/server/**`.
  - Stephen owns `src/app/**`, `src/ui/**` and `src/server/ml/**`.
- MongoDB Atlas holds recalls, listings, deals, verifications and passports. Change streams push live
  state to the boards over SSE.
- Python (`ml/`, `data/`) trains the banned-product classifier and builds the recall index offline. The
  app only loads exported artifacts (JSON weights, Atlas documents).
- An Expo iOS app does on-device label OCR for the pickup scan.
- A small local bridge on the Mac talks to the USB NFC reader for the table Checkpoint.

**Tech stack:**
- Next.js (latest, App Router, TypeScript), Visa Nova (`@visa/nova-react`), Visa Chart Components
  (`@visa/charts-react`).
- MongoDB Atlas (Node driver), `cybersource-rest-client` (Visa Acceptance).
- Ed25519 (`@noble/ed25519`) for Trusted Agent Protocol; `@solana/kit` + Metaplex Core (`mpl-core`,
  Umi); `@huggingface/transformers` (CLIP in Node).
- Gemini (`@google/genai`), ElevenLabs; vitest, Playwright.
- Python 3.11 with scikit-learn; Expo (iOS) with `expo-text-extractor`; `nfc-pcsc` for the ACR122U reader.

**Spec:** `../research/71-SECONDHAND-SAFE-BUILD-PLAN.md` (the full galaxy plan) and
`../research/61-VISA-PICK-SecondHand-Safe.md`. Handoff: `../HANDOFF-SECONDHAND-SAFE.md`.

**Owners:** **T** = Tylin (backend). **S** = Stephen (frontend, AI/ML/DL, mobile). Every task has exactly
one owner.

## Global Constraints

- Hacking ends **Sun 2026-09-27 8:00 AM ET**. Submit to **Devpost AND expo.hexlabs.org**.
- Tracks: Oracle of the Deep; sponsors Visa + Notability. MLH: MongoDB Atlas, Solana, ElevenLabs, .Tech,
  Gemini, Vultr, Tiger Data, Backboard (each only if its job below is really wired).
- Verdict words: only `RECALL_MATCH`, `BANNED_TYPE`, `NO_MATCH` (shown as "No match in CPSC/NHTSA as of
  <date>"), `UNREADABLE`, `NEEDS_CHECK`. Never the word "safe".
- Visa wording: "authorization", "capture", "reversal". Never "void". Sandbox only, no real money. Never
  claim Visa Intelligent Commerce unless Visa grants access.
- Visa Acceptance sandbox host: `apitest.cybersource.com`. Test card `4111111111111111`. The reversal amount
  equals the auth amount; always capture the full amount.
- TAP: RFC 9421 signature, `alg=ed25519`, `tag="agent-payer-auth"`, `created`/`expires` window of at most
  480 s, single-use nonce.
- Legal rules (verified 2026-09-25):
  - recalled = illegal to sell
  - inclined sleepers + crib bumpers = banned (mesh liners excepted)
  - drop-side and pre-2011 cribs cannot be resold
  - in-bed sleepers must meet the bassinet standard (stand required), so NEEDS_CHECK
  - car seats: recall match = RECALL_MATCH, else NEEDS_CHECK + the NHTSA used-seat checklist
- No mock data anywhere a judge can reach. Demo deals are real listings of the real props on our table,
  labelled as such.
- Secrets only in `.env.local` (gitignored) and Vercel/GitHub secrets. Keys move between laptops by AirDrop.
  Never commit keys.
- CI must be green on the merged main SHA (count check-runs ≥ jobs, none failing) before claiming done.
- No em dashes in judge-facing copy.

## Review Focus

1. **A blurry, worn or glare-covered label:** the pickup returns `UNREADABLE`, never `NO_MATCH`, and
   offers manual model entry. The hold is not captured. (Test in Task 5 and Task 13.)
2. **OCR character slips (O/0, I/1, missing hyphen):** `BHCOO1`, `B-HC001` and `bhc 001` still match recall
   26-061. (Test in Task 5.)
3. **Double taps and retries:** capturing twice, reversing after capture, or capturing a reversed deal must
   be refused by the deal state machine, and the Visa call must not be made twice. (Test in Task 7.)
4. **A pickup that never happens:** a HELD deal older than its deadline is reversed by a sweeper so money is
   never left held. (Test in Task 7.)
5. **A phone with no camera permission or no camera:** the pickup page accepts a photo upload and a typed
   model number, with the same verdict path. (Test in Task 14.)

---

## File structure

```
secondhand-safe/
  PLAN.md  README.md  .gitignore  .env.example  package.json  vitest.config.ts  playwright.config.ts
  .github/workflows/ci.yml            # lint, typecheck, vitest, pytest, build, e2e (T)
  .github/workflows/probe.yml         # live probe of the deployed URL every 30 min (T)
  src/
    core/verdict.ts                   # pure verdict rules + model normalization (T, reviewed by S)
    core/types.ts                     # shared types (T)
    server/visa/acceptance.ts         # auth / capture / reversal / microform / TMS (T)
    server/visa/direct.ts             # Visa Direct push funds (T, Tier 2)
    server/tap/tap.ts                 # TAP sign + verify (T)
    server/db/mongo.ts                # Atlas client, collections, indexes (T)
    server/deals/machine.ts           # deal state machine HELD->CAPTURED|REVERSED (T)
    server/recalls/match.ts           # Atlas Search fuzzy match -> verdict (T)
    server/solana/passport.ts         # Metaplex Core passport + memo anchor (T)
    server/ml/classify.ts             # CLIP embed + trained head (S)
    server/ml/label.ts                # Gemini vision label reader + OpenAI fallback (S)
    server/ml/agent.ts                # Gemini shopping agent tools (S)
    server/voice/elevenlabs.ts        # spoken verdicts (S)
    app/api/*/route.ts                # HTTP routes (T, except /api/agent + /api/classify = S)
    app/(shop)/..., app/pickup, app/board, app/map, app/atlas, app/trust, app/judge, app/passport/[id]  (S)
    ui/*                              # Nova-based components: GlassDealCard, ScanOverlay, VerdictBanner (S)
  ml/                                 # Python: harvest, label, embed, train, eval (S)
  data/                               # Python: build recall index (T)
  mobile/                             # Expo iOS pickup scanner (S)
  bridge/                             # local Node bridge for the ACR122U NFC reader (S)
  tests/                              # vitest unit + integration; e2e/ Playwright
```

---

### Task 1 (T): Repo, CI and env contract

**Files:**
- Create: `package.json`, `.env.example`, `.github/workflows/ci.yml`, `vitest.config.ts`
- Test: `tests/env.test.ts`

**Interfaces:**
- Produces: `src/server/env.ts` exporting `env()` returning the typed variables below; it throws a named
  error listing the missing keys.

- [ ] **Step 1: Scaffold Next.js in place.** `npx create-next-app@latest . --ts --app --eslint --src-dir
  --import-alias "@/*" --no-tailwind`. Keep the existing `PLAN.md`, `README.md`, `.gitignore`.
- [ ] **Step 2: Add deps.** `npm i mongodb cybersource-rest-client @noble/ed25519 @noble/hashes zod
  @google/genai @huggingface/transformers @visa/nova-react @visa/nova-styles @visa/charts-react` and
  `npm i -D vitest @playwright/test`.
- [ ] **Step 3: Write the failing test.**

```ts
// tests/env.test.ts
import { describe, it, expect } from "vitest";
import { parseEnv } from "@/server/env";
describe("env", () => {
  it("names every missing key", () => {
    expect(() => parseEnv({})).toThrow(/VISA_MERCHANT_ID.*MONGODB_URI/s);
  });
});
```

- [ ] **Step 4: Implement `src/server/env.ts`.**

```ts
import { z } from "zod";
const schema = z.object({
  VISA_MERCHANT_ID: z.string().min(1), VISA_KEY_ID: z.string().min(1), VISA_SECRET_KEY: z.string().min(1),
  VISA_HOST: z.string().default("apitest.cybersource.com"),
  MONGODB_URI: z.string().min(1), MONGODB_DB: z.string().default("secondhand_safe"),
  GEMINI_API_KEY: z.string().min(1), ELEVENLABS_API_KEY: z.string().optional(),
  TAP_AGENT_PRIVATE_KEY_HEX: z.string().length(64), TAP_AGENT_KEY_ID: z.string().min(1),
  SOLANA_RPC_URL: z.string().default("https://api.devnet.solana.com"), SOLANA_SECRET_KEY_B58: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url(),
});
export type Env = z.infer<typeof schema>;
export function parseEnv(src: Record<string, string | undefined>): Env {
  const r = schema.safeParse(src);
  if (!r.success) throw new Error("Missing or invalid env: " + r.error.issues.map(i => i.path.join(".")).join(", "));
  return r.data;
}
let cached: Env | undefined;
export const env = () => (cached ??= parseEnv(process.env));
```

- [ ] **Step 5: Write `.env.example`** with every key above and empty values. Write
  `.github/workflows/ci.yml` running `npm ci`, `npm run lint`, `npx tsc --noEmit`, `npx vitest run`,
  `npm run build` on Node 22, and a `python` job running `pip install -r ml/requirements.txt && pytest ml`.
- [ ] **Step 6: Run** `npx vitest run tests/env.test.ts`. Expected: PASS.
- [ ] **Step 7: Commit + push.** `git add -A && git commit -m "chore: scaffold app, env contract, CI"`.
  Then confirm CI is green on that SHA.

### Task 2 (T): Visa Acceptance authorization, capture, reversal

**Files:**
- Create: `src/server/visa/acceptance.ts`
- Test: `tests/visa.live.test.ts`

**Interfaces:**
- Produces:
  - `authorize(p: {amountUsd: string; ref: string; card?: {number:string; month:string; year:string}; transientTokenJwt?: string}): Promise<{id: string; status: "AUTHORIZED" | string; raw: unknown}>`
  - `capture(id: string, amountUsd: string, ref: string): Promise<{id: string; status: string}>`
  - `reverse(id: string, amountUsd: string, ref: string): Promise<{id: string; status: "REVERSED" | string}>`

- [ ] **Step 1: Write the failing live test.** In CI it FAILS if the keys are missing; it never skips.

```ts
import { describe, it, expect } from "vitest";
import { authorize, capture, reverse } from "@/server/visa/acceptance";
const card = { number: "4111111111111111", month: "12", year: "2031" };
describe("Visa Acceptance sandbox (live)", () => {
  it("auth then capture", async () => {
    const a = await authorize({ amountUsd: "64.00", ref: "test-cap-" + Date.now(), card });
    expect(a.status).toBe("AUTHORIZED");
    const c = await capture(a.id, "64.00", "test-cap");
    expect(["PENDING", "TRANSMITTED", "CAPTURED"]).toContain(c.status);
  }, 30000);
  it("auth then reversal", async () => {
    const a = await authorize({ amountUsd: "64.00", ref: "test-rev-" + Date.now(), card });
    const r = await reverse(a.id, "64.00", "test-rev");
    expect(r.status).toBe("REVERSED");
  }, 30000);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/visa.live.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Use `cybersource-rest-client` `PaymentsApi.createPayment`
  (`processingInformation.capture=false`), `CaptureApi.capturePayment`, `ReversalApi.authReversal`, with
  `merchantConfig = { authenticationType: "http_signature", runEnvironment: env().VISA_HOST,
  merchantID, merchantKeyId, merchantsecretKey }`. Check the exact SDK method names against Context7
  (`cybersource-rest-client`) before coding. Map the SDK callbacks to promises. Return `status` from the
  response body.
- [ ] **Step 4: Run** the test again. Expected: PASS against the real sandbox.
- [ ] **Step 5: Commit + push**, then add `VISA_*` as GitHub Actions secrets so CI runs the live test.

### Task 3 (T): Trusted Agent Protocol sign and verify

**Files:**
- Create: `src/server/tap/tap.ts`
- Test: `tests/tap.test.ts`

**Interfaces:**
- Produces:
  - `signRequest(method: string, url: string, body: string, key: {id: string; privHex: string}, now?: number): {signatureInput: string; signature: string; nonce: string}`
  - `verifyRequest(method: string, url: string, body: string, headers: {signatureInput: string; signature: string}, pubHexById: (id: string) => string | undefined, seenNonce: (n: string) => Promise<boolean>, now?: number): Promise<{ok: true} | {ok: false; reason: string}>`

- [ ] **Step 1: Write the failing tests** for: valid passes; edited body fails `digest`; replayed nonce fails
  `replay`; `created` 600 s old fails `expired`; unknown keyid fails `unknown-key`.

```ts
import { describe, it, expect } from "vitest";
import * as ed from "@noble/ed25519";
import { signRequest, verifyRequest } from "@/server/tap/tap";
const priv = ed.utils.randomPrivateKey(); const privHex = Buffer.from(priv).toString("hex");
const pubHex = Buffer.from(ed.getPublicKey(priv)).toString("hex");
const keys = (id: string) => (id === "agent-1" ? pubHex : undefined);
const seen = new Set<string>(); const seenNonce = async (n: string) => { const s = seen.has(n); seen.add(n); return s; };
describe("TAP", () => {
  const body = JSON.stringify({ listingId: "L1", amountUsd: "64.00" });
  it("valid passes then replay fails", async () => {
    const h = signRequest("POST", "https://x/api/checkout", body, { id: "agent-1", privHex });
    expect(await verifyRequest("POST", "https://x/api/checkout", body, h, keys, seenNonce)).toEqual({ ok: true });
    expect(await verifyRequest("POST", "https://x/api/checkout", body, h, keys, seenNonce)).toMatchObject({ ok: false, reason: "replay" });
  });
  it("edited body fails", async () => {
    const h = signRequest("POST", "https://x/api/checkout", body, { id: "agent-1", privHex });
    const r = await verifyRequest("POST", "https://x/api/checkout", body.replace("64.00", "6.40"), h, keys, seenNonce);
    expect(r).toMatchObject({ ok: false, reason: "digest" });
  });
  it("expired fails", async () => {
    const t = Math.floor(Date.now() / 1000) - 600;
    const h = signRequest("POST", "https://x/api/checkout", body, { id: "agent-1", privHex }, t);
    expect(await verifyRequest("POST", "https://x/api/checkout", body, h, keys, seenNonce)).toMatchObject({ ok: false, reason: "expired" });
  });
});
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** per RFC 9421.
  - The signature base covers `"@method"`, `"@authority"`, `"@path"` and `"content-digest"`
    (`sha-256=:<b64>:`).
  - `Signature-Input: sig1=("@method" "@authority" "@path" "content-digest");created=..;expires=created+480;keyid="..";alg="ed25519";nonce="..";tag="agent-payer-auth"`.
  - Verify the digest first, then the window, then the nonce, then the signature.
- [ ] **Step 4: Run.** Expected: PASS. **Step 5: Commit + push.**

### Task 4 (T): Recall index (CPSC + NHTSA), in Atlas

**Files:**
- Create: `data/build_recall_index.py`, `data/requirements.txt`, `data/test_build.py`

**Interfaces:**
- Produces: the Atlas collection `recalls`, documents
  `{recallNumber, source:"CPSC"|"NHTSA", title, brand, models:[string], modelsNorm:[string], batches:[string], upcs:[string], dateRange:{from,to}, hazard, remedy, url, imageUrls:[string], category, fetchedAt}`.

- [ ] **Step 1: Write the failing test.** `normalize("B-HC 001") == "BHC001"`. For recall 26-061, the parsed
  document has `"BHC001"` in `models` and `"202408"` in `batches`.
- [ ] **Step 2: Implement.**
  - CPSC: GET `https://www.saferproducts.gov/RestWebServices/Recall?format=json&ProductName=<term>` plus
    `RecallDateStart/End` paging. Terms: bassinet, crib, sleeper, high chair, stroller, play yard, swing,
    bouncer, carrier, car seat. `Products[].Model` is empty, so extract models and batches from
    `Description` + the recall page with Gemini, using a JSON schema of `{models[], batches[], upcs[],
    dateFrom, dateTo, category}`. Hand-check 20 docs and record them in `data/handcheck.md`.
  - NHTSA: download `FLAT_RCL_POST_2010.zip`, keep `RCLTYPECD == "C"`, and map MAKETXT, MODELTXT,
    BGMAN/ENDMAN.
  - Upsert into Atlas by `recallNumber`.
- [ ] **Step 3: Run** `pytest data -q`. Expected: PASS. Run the builder once against Atlas and print the counts
  per source.
- [ ] **Step 4: Commit + push.**

### Task 5 (T): Verdict rules and matcher

**Files:**
- Create: `src/core/verdict.ts`, `src/server/recalls/match.ts`
- Test: `tests/verdict.test.ts`

**Interfaces:**
- Produces:
  - `normalizeModel(s: string): string`
  - `decide(input: {label: {brand?: string; model?: string; batch?: string; upc?: string; readable: boolean}; bannedType?: {cls: "inclined_or_inbed_sleeper"|"crib_bumper"|"drop_side_crib"|"other"; p: number}; category?: string; matches: RecallDoc[]}): Verdict`
  - `Verdict = {kind: "RECALL_MATCH"|"BANNED_TYPE"|"NO_MATCH"|"UNREADABLE"|"NEEDS_CHECK"; recall?: RecallDoc; reason: string; asOf: string}`

- [ ] **Step 1: Write the failing table test.**

```ts
import { describe, it, expect } from "vitest";
import { normalizeModel, decide } from "@/core/verdict";
const r26061 = { recallNumber: "26-061", models: ["BHC001"], modelsNorm: ["BHC001"], batches: ["202408"], category: "high chair" } as any;
describe("verdict", () => {
  it.each(["BHC001", "B-HC001", "bhc 001", "BHCOO1", "BHC0O1"])("normalizes %s", s => expect(normalizeModel(s)).toBe("BHC001"));
  it("recall match", () => expect(decide({ label: { model: "BHCOO1", readable: true }, matches: [r26061] }).kind).toBe("RECALL_MATCH"));
  it("unreadable is never no-match", () => expect(decide({ label: { readable: false }, matches: [] }).kind).toBe("UNREADABLE"));
  it("banned type wins over no-match", () => expect(decide({ label: { model: "X9", readable: true }, bannedType: { cls: "crib_bumper", p: 0.93 }, matches: [] }).kind).toBe("BANNED_TYPE"));
  it("car seat without recall needs a check", () => expect(decide({ label: { model: "SEAT1", readable: true }, category: "car seat", matches: [] }).kind).toBe("NEEDS_CHECK"));
  it("clean", () => expect(decide({ label: { model: "ZZ123", readable: true }, matches: [] }).kind).toBe("NO_MATCH"));
});
```

- [ ] **Step 2: Implement.**
  - `normalizeModel` uppercases, strips non-alphanumerics, and maps O→0 only where it sits between digits
    or after a 3-letter prefix.
  - Do NOT map globally: fold O/0 and I/1 on both sides of the comparison instead
    (`fold = s => s.replace(/O/g,"0").replace(/[IL]/g,"1")`) and compare the folded forms.
  - `decide` order: unreadable → recall match (on the folded model plus batch when the recall lists
    batches) → banned type (p ≥ 0.8) → car seat → no match.
  - `match.ts` queries Atlas Search `text` with `fuzzy:{maxEdits:1}` on `modelsNorm`, then calls `decide`.
- [ ] **Step 3: Run.** Expected: PASS. **Step 4: Commit + push.**

### Task 6 (T): Atlas collections, indexes, change stream → SSE

**Files:**
- Create: `src/server/db/mongo.ts`, `src/app/api/stream/route.ts`, `data/atlas_indexes.json`
- Test: `tests/stream.int.test.ts`

**Interfaces:**
- Produces: `db()`; the collections `recalls, listings, deals, verifications, passports, nonces`;
  `GET /api/stream` (SSE `event: deal` on every insert/update in `deals`).

- [ ] **Step 1: Failing integration test:** insert a deal and receive the SSE event within 3 s.
- [ ] **Step 2: Implement.**
  - Create the Atlas Search index `recall_models` (fuzzy text on `modelsNorm`, autocomplete on `models`)
    and the vector index `recall_images` (512-d cosine). That is 3 indexes max on M0.
  - The TTL index on `nonces.createdAt` is 600 s.
  - `/api/stream` opens `deals.watch()` and writes SSE.
- [ ] **Step 3: Run.** Expected: PASS. **Step 4: Commit + push.**

### Task 7 (T): Deal state machine, checkout and pickup routes

**Files:**
- Create: `src/server/deals/machine.ts`, `src/app/api/checkout/route.ts`, `src/app/api/pickup/route.ts`,
  `src/app/api/cron/sweep/route.ts`
- Test: `tests/machine.test.ts`

**Interfaces:**
- Consumes: `authorize/capture/reverse` (Task 2), `verifyRequest` (Task 3), `decide` + match (Task 5).
- Produces:
  - `POST /api/checkout {listingId, amountUsd, transientTokenJwt?}` with TAP headers → `{dealId, status:"HELD", authId}`
  - `POST /api/pickup {dealId, label:{...}, photoB64?}` → `{status:"CAPTURED"|"REVERSED"|"HELD", verdict}`

- [ ] **Step 1: Failing tests** with a fake Visa port injected:
  - HELD→CAPTURED once, and a second capture is refused with no Visa call.
  - Reverse after capture is refused.
  - UNREADABLE leaves the deal HELD.
  - A HELD deal past `holdUntil` is reversed by `sweep()`.
- [ ] **Step 2: Implement.**
  - Transitions are guarded in Mongo with `findOneAndUpdate({_id, status:"HELD"}, {$set:{status:"CAPTURING"}})`
    before calling Visa, so double taps can't double-charge.
  - Record every Visa response on the deal.
  - `sweep` runs from a Vercel cron every 10 min.
- [ ] **Step 3: Run.** Expected: PASS. **Step 4: Commit + push.**

### Task 8 (T): Public check + stats endpoints (judge-runnable)

**Files:**
- Create: `src/app/api/check/route.ts`, `src/app/api/stats/route.ts`, `src/app/api/health/route.ts`
- Test: `tests/public.int.test.ts`

- [ ] **Step 1:** Failing test: `GET /api/check?model=BHC001` returns `RECALL_MATCH` with `26-061`.
  `GET /api/stats` returns `{scanned, flagged, precisionReviewed, asOf}` computed from Atlas, not constants.
- [ ] **Step 2:** Implement. **Step 3:** PASS. **Step 4:** Commit + push. The README prints the `curl`.

### Task 9 (T): Solana item passport + memo anchor

**Files:**
- Create: `src/server/solana/passport.ts`, `src/app/api/passport/route.ts`
- Test: `tests/passport.devnet.test.ts`

**Interfaces:**
- Produces: `mintPassport({dealId, verdict, verificationHash}): Promise<{asset: string; explorerUrl: string; memoSig: string}>`

- [ ] **Step 1:** Failing devnet test: mint a Metaplex Core asset whose Attributes plugin holds
  `{check_1: "<asOf>|<verdict>|<hash>"}`; the explorer URL returns 200; the memo transaction holds the hash.
- [ ] **Step 2:** Implement with Umi + `mpl-core` `create()` and the Memo program
  `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`.
- [ ] **Step 3:** PASS. **Step 4:** Commit + push.

### Task 10 (T, Tier 2): Microform, TMS, Visa Direct, Payment Passkey, recall watch

- [ ] Microform: `POST /microform/v2/sessions` gives the capture context; the client loads Microform; the
  checkout uses `tokenInformation.transientTokenJwt`. Test: a live auth with a token passes.
- [ ] TMS: `actionList:["TOKEN_CREATE"]` on checkout; store the customer token; a second checkout uses it.
- [ ] Visa Direct: VDP sandbox project, two-way SSL cert, `POST /visadirect/fundstransfer/v1/pushfundstransactions`
  after CAPTURED. Test: sandbox 200.
- [ ] Payment Passkey: VDP sandbox, WebAuthn step-up before checkout.
- [ ] Recall watch: an Atlas trigger (or a change stream worker) on `recalls` insert re-checks `passports`
  and sends a web push. Test: insert recall 26-568, and the matching passport flips to `RECALL_MATCH`.

### Task 11 (S): Listing harvest + measured scan

**Files:**
- Create: `ml/harvest.py`, `ml/scan.py`, `ml/test_harvest.py`

- [ ] Harvest 1,000+ real listings (eBay Browse API baby categories + Craigslist Atlanta via Apify), keeping
  the source URL, title, price, location and image URLs. Store them in Atlas `listings`.
- [ ] `scan.py` runs the classifier (Task 12) and the text model extraction → matcher (Task 5) on every
  listing and writes `listings.verdict`.
- [ ] Hand-review every red flag in `ml/review.csv` (so the precision is measured). `/api/stats` reads these
  results.

### Task 12 (S): Banned-product classifier (Oracle of the Deep core)

**Files:**
- Create: `ml/embed.py`, `ml/train.py`, `ml/eval.py`, `ml/test_eval.py`, `src/server/ml/classify.ts`,
  `public/models/head.json`

**Interfaces:**
- Produces: `classify(imageUrlOrBytes): Promise<{cls: "inclined_or_inbed_sleeper"|"crib_bumper"|"drop_side_crib"|"other"; p: number; probs: Record<string, number>}>`

- [ ] Dataset: 4 classes, at least 40 train + 15 held-out images per class, with held-out images only from
  listing photos (a different source than training). CLIP zero-shot pre-sort, then a human confirms each
  label. Labels live in `ml/labels.csv`.
- [ ] Embed with CLIP `clip-vit-base-patch32` (the same weights as transformers.js
  `Xenova/clip-vit-base-patch32`). Train sklearn logistic regression; compare against zero-shot CLIP
  prompts and against a DINOv2 linear probe.
- [ ] `ml/test_eval.py`: the trained head beats zero-shot on held-out macro-F1, and
  `ml/out/metrics.json` is written (the map page reads it; nothing typed by hand).
- [ ] Export `head.json` (weights, bias, classes). `classify.ts` computes the image embedding in Node and
  applies the head. Test: its logits match Python's on 5 fixture images to 1e-3.

### Task 13 (S): Label reader (Gemini vision + OpenAI fallback)

**Files:**
- Create: `src/server/ml/label.ts`
- Test: `tests/label.live.test.ts`

**Interfaces:**
- Produces: `readLabel(photo: Buffer): Promise<{readable: boolean; brand?: string; model?: string; batch?: string; date?: string; boxes: {field: string; x:number; y:number; w:number; h:number}[]; ms: number}>`

- [ ] Pin the Gemini model at H0 from the models list. Use JSON schema output with bounding boxes for the
  AR overlay. If a read takes over 6 s or returns invalid JSON, fall back to the OpenAI vision model.
- [ ] Live test on the printed 26-061 label photo in `tests/fixtures/label_26061.jpg`: model `BHC001`,
  batch `202408`. A blurry fixture returns `readable:false`.

### Task 14 (S): Web UI (Nova), boards, judge door

**Files:**
- Create: `src/app/(shop)/page.tsx`, `src/app/deal/[id]/page.tsx`, `src/app/pickup/page.tsx`,
  `src/app/board/page.tsx`, `src/app/map/page.tsx`, `src/app/atlas/page.tsx`, `src/app/trust/page.tsx`,
  `src/app/judge/page.tsx`, `src/app/passport/[id]/page.tsx`, `src/ui/GlassDealCard.tsx`,
  `src/ui/ScanOverlay.tsx`, `src/ui/VerdictBanner.tsx`
- Test: `tests/e2e/*.spec.ts` (Playwright against the Vercel preview)

- [ ] The shop page lists real listings with a pin color, a verdict word and the notice link.
- [ ] The pickup page opens the camera and shows a live `ScanOverlay` (scanline + field boxes from
  `readLabel`). It falls back to photo upload + typed model if there is no camera or no permission (Review
  Focus 5).
- [ ] The board shows one `GlassDealCard` per deal via `/api/stream`, with HELD amber → CAPTURED green or
  REVERSED red and a sound per state.
- [ ] The map is a deck.gl hex map of flagged listings plus `metrics.json`. The atlas page uses
  `embedding-atlas`. The trust page is the T&S console. The judge page is a numbered 3-minute itinerary
  with no login.
- [ ] E2E: the Deal 1 flow ends REVERSED; the Deal 2 flow ends CAPTURED and shows the passport link.

### Task 15 (S): Checkpoint kiosk + NFC bridge

**Files:**
- Create: `src/app/checkpoint/page.tsx`, `bridge/index.mjs`, `bridge/package.json`

- [ ] The kiosk page takes barcode-scanner input (keyboard wedge) plus the camera, and calls
  `/api/pickup`. Red/green full-screen flash + sound.
- [ ] Bridge: `nfc-pcsc` on the ACR122U writes the NDEF URL `PUBLIC_BASE_URL/passport/<asset>` to the
  sticker when the kiosk posts to `ws://localhost:8787`. Test: write, then read back the same URL.

### Task 16 (S): Expo iOS pickup scanner

**Files:**
- Create: `mobile/` (Expo app), `mobile/app/index.tsx`

- [ ] Camera capture → `expo-text-extractor` on-device OCR → `/api/pickup` with the text plus the photo.
  Build a dev client and run it on Stephen's iPhone. Show the verdict and speak it (ElevenLabs audio URL
  from the API).

### Task 17 (S): Gemini shopping agent + ElevenLabs voice

**Files:**
- Create: `src/server/ml/agent.ts`, `src/app/api/agent/route.ts`, `src/server/voice/elevenlabs.ts`

- [ ] Agent tools: `searchListings(query, maxPrice, near)`, `prescreen(listingId)`, `startCheckout(listingId)`.
  The last one TAP-signs the checkout request. Spoken verdicts use `eleven_flash_v2_5` (English + Spanish).

### Task 18 (T): Deploy, live probe, stills

- [ ] Vercel: create a dedicated project `secondhand-safe-web`, check `.vercel/project.json`, and set the env
  vars.
- [ ] `probe.yml` every 30 min hits `/api/health`, `/api/check?model=BHC001` and a sandbox auth +
  reversal. Never disable it after submission.
- [ ] Playwright stills of every judge page at desktop and phone widths.

### Task 19 (S): Submission package

- [ ] Writeup (Visa Acceptance + Trusted Agent Protocol named 3+ times, MongoDB Atlas, Solana), a 2-3 min
  video, poster, Notability note + 2 screenshots, .Tech domain.
- [ ] Submit to Devpost AND expo.hexlabs.org and reload-verify both. Check every box: Oracle of the Deep,
  Visa, Notability, the MLH prizes whose jobs are wired.

## Self-review notes

- Spec coverage: every Tier 1 item in research/71 maps to Tasks 1-9, 11-15 and 18. Tier 2 maps to Tasks 10,
  16 and 17. Tier 3 (Vultr, Tiger Data, Backboard, YOLO label finder, Apple Wallet) is not broken into tasks
  yet. Add them only once Tier 1 is green on main.
- Type names are consistent across tasks: `Verdict`, `decide`, `readLabel`, `classify`, `authorize/capture/reverse`, `mintPassport`.
