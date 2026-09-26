# Lullabuy: Devpost draft (edit in your own voice before submitting)

> Numbers below are copied from `docs/FACTS.json` on 2026-09-26. If you regenerate FACTS, re-copy them.
> Lines marked TODO need you or Tylin. Delete any integration line that is not live when you submit.

## Tagline

See the recall before your money moves. Lullabuy holds a Visa payment until a camera reads the baby gear's
label.

## Inspiration

About 100 babies died in Fisher-Price Rock 'n Play sleepers, and at least 8 of those deaths happened after
the recall (CPSC, Jan 2023). This year Consumer Reports looked at secondhand marketplaces and found 50 of the
first 65 Facebook Marketplace listings it reviewed were banned infant in-bed sleepers, before it stopped
counting. Marketplaces filter what they can read in a listing. Nobody reads the label on the actual item
when the money changes hands in a parking lot.

TODO (Stephen): one or two sentences on why this one matters to you.

## What it does

0. **Find it.** The parent says or types what they need ("a bassinet for my newborn under $80, pickup in
   Atlanta"). Gemini turns that into a search over 1662 real listings we scanned, and every result comes back
   already checked: red ones cannot be bought, amber ones need a look at pickup. Our agent can then buy for them.
1. **Agree and hold.** The buyer agrees on a price and types their card into Visa's own Microform fields.
   Lullabuy asks Visa to authorize it with capture off. The money is held, not sent.
2. **Meet and scan.** At pickup, the buyer photographs the label. The barcode is read on the phone, the label
   text is read into model, batch and manufacture date, and our own model looks at the photo for product
   types that are banned outright (inclined sleepers, padded crib bumpers, drop-side cribs).
3. **Check.** Those values go against 1137 CPSC nursery and children's recalls and 71 NHTSA child car seat
   recall campaigns. The rules follow the law: a recall only counts for the batch or date range it names,
   mesh crib liners are allowed, and a car seat always gets NHTSA's used-seat check.
4. **Capture or reverse.** No match: the hold is captured and the seller is paid. Recalled or banned: the
   hold is reversed. Anything uncertain keeps the hold and moves no money. The app never says "safe".

## How we built it

- **Visa Acceptance (sandbox):** authorization with capture off, full capture, full reversal, signed with
  HTTP Signature. A signed deal token binds the deal, the authorization and the amount, so the pickup scan can
  only settle the hold it was issued for. Replaying a settlement is refused by Visa and shown as refused.
- **Visa Acceptance Microform:** the card number and CVV are typed into Visa-hosted fields and come back as a
  one-time token, so the card never reaches our server. Verified end to end in a browser against the sandbox.
- **Visa Token Management Service and card-linked offers:** a buyer can save the card with Visa and pay the next
  hold without typing it again; the browser keeps only our signed wrapper around Visa's token. Testing it, we
  found that when Visa applies a card-linked offer ("20 percent off" a card's 10th purchase), the reply carries
  a lower authorized amount and no status field. We hold exactly what Visa authorized and show the saving.
- **Mobile app:** the same product on iOS and Android (Expo): shop, scan a label with the camera, and the deal
  board, all on the live API.
- **Trusted Agent Protocol:** an AI agent buying for a parent signs its checkout with RFC 9421 HTTP Message
  Signatures (Ed25519), covering the method, host, path and a digest of the body. Our merchant checks the
  signature, the time window and a one-time nonce before calling Visa. On `/pickup` you can send a request
  whose amount was edited after signing and watch it get refused. Verified means the agent is who it says
  and the request was not changed; it does not mean a parent approved the purchase.
- **MCP server:** the recall check is also an MCP tool (`recall_check` at `/api/mcp`), so any AI shopping
  agent can check an item before it buys.
- **Recall index:** 6036 CPSC recalls pulled from the CPSC API, 1137 kept as nursery and children's products,
  plus 71 NHTSA child restraint campaigns. Two hand checks of 20 records each found three extraction bugs,
  which we fixed and wrote up in `data/handcheck.md`.
- **Gemini shopping agent:** Gemini 3.5 Flash turns a spoken or typed request into filters over our scanned
  listings. It never decides what is allowed; the recall index, our model and our own review do, and the
  server refuses to let the agent buy a red listing. In production Gemini runs with no stored key: Vercel's
  identity token is exchanged with Google Workload Identity Federation for a short-lived token.
- **Solana item passport:** when a sale captures, a Memo transaction on Solana devnet stores the SHA-256 of the
  pickup record (no personal data on chain). The passport page reads it back and checks the signer, the
  transaction and the hash, so anyone can verify what the check said at the time of sale.
- **MongoDB Atlas:** every hold and settlement is recorded; the seller scans a QR on the buyer's phone and
  watches the same deal live, and a deal board shows every deal.
- **Gemini:** Gemini 3.5 Flash reads the product label photo into brand, model, batch and date with a box for
  each field. It also read all 1137 recall notices for model numbers, batches and UPCs. A value is kept only
  if it appears word for word in that recall's text, which raised the recalls we can match on from 449 to 822.
- **Banned-type model:** CLIP ViT-B/32 image embeddings with a logistic-regression head we trained on reviewed
  labels. It runs in the buyer's browser with transformers.js, and we trained it on embeddings from that same
  runtime so the phone sees exactly what training saw. On products it had never seen, macro-F1 is 0.7243
  (95% CI 0.6017 to 0.8127), against 0.558 for off-the-shelf CLIP. On ordinary baby items it wrongly flags 2
  of 107, against 38 for off-the-shelf CLIP.
- **The Atlanta scan:** we harvested 1662 real listings (Craigslist Atlanta and eBay) and ran them all through
  the model, then read every flag ourselves. Round 1 raised 39 flags. We added the false alarms (crib skirts,
  rail covers, dollhouse cribs) to training, without touching the test set, and round 2 raised 9.
- **ElevenLabs:** the verdict is spoken at the curb in English or Spanish. TODO: live only after the key is
  pushed to production.
- **Frontend:** Next.js 16, GSAP and Lenis motion, MapLibre with OpenFreeMap for the scan map.
- **Engineering:** CI runs lint, types, unit tests, a build, pytest, a JS-vs-Python classifier parity suite,
  Playwright end to end (including both real Visa paths when keys are present), a secret scan and an em-dash
  check. A probe hits production every 30 minutes.

## How we used Notability (for the Notability challenge; tag the project "Notability")

We planned and rehearsed the build in Notability. Our architecture, money-flow and expo-demo note lives there,
and Notability's AI turned it into Smart Notes ("System Architecture & Payment Flow") and a 20-question
practice quiz that we used to drill judge questions, like "what triggers a reversal of the payment hold?".
Screenshots: `docs/stills/notability/` (note with Smart Notes, the generated quiz, the quiz in use).

## Challenges we ran into

- The model's first pass on real listings flagged crib skirts and dollhouse furniture. Reading every flag and
  feeding the mistakes back fixed most of it.
- Banned products are rare on eBay and Craigslist (eBay filters them out), so our test set had to be grouped
  by product instead of being made only of listing photos.
- Our first recall extraction turned phrases like "4-in-1" and years into model numbers. The listing scan
  exposed it.
- Payment states: an adversarial review found that a failed or replayed settlement could be shown as HELD.
  Now anything Visa did not confirm is shown as refused or unknown, never as a result.
- Gemini's recall pass added model numbers like "4340" that several brands use. Our first fix trusted the
  brand if the listing named it, and review found brands like "Summer" and "Gap" in ordinary listing text.
  Now a match on a short number never moves money: the hold waits for a person to check the brand.

## Accomplishments that we're proud of

- A real Visa hold that a camera settles, end to end, tested in a browser.
- A model that runs on the buyer's phone and was measured on products it had never seen.
- Every number on the site is recomputed by a script and served from an open endpoint.

## What we learned

DRAFT (written from what actually happened this weekend; Stephen and Tylin, rewrite it in your own words):

- The danger is not where we first looked. We expected banned sleepers all over eBay. Our scan of 1662 real
  listings found about one. The big marketplaces already filter the text they can read. The problem is at the
  handoff, when cash or a card moves for an item nobody has looked at closely.
- A model is only as good as the mistakes you feed back. Our first pass on real listings flagged crib skirts
  and dollhouse furniture. We reviewed every flag by hand, added the false alarms to training, and the flags
  went from 39 to 9 without touching the test set.
- Money code needs someone trying to break it. Review rounds found bugs our tests did not, like model numbers
  such as "4340" that several brands share, and brand names like "Summer" and "Gap" that show up in ordinary
  listing text. We changed the rule so a short number never moves money on its own.
- Visa's hold is the right tool. Authorize with capture off, then capture or reverse, is how hotels and gas
  pumps already work, and it fits a parking-lot sale exactly.
- You can use a cloud model without a stored key. Our server proves who it is to Google with a short-lived
  identity token, so there is no Gemini key sitting in our settings.

## What's next

- Seller-side confirmation of the scan (today the buyer's device reports it).
- Visa Direct payouts to the seller's card, and seller-side confirmation on their own device.
- Bring the check to Facebook Marketplace handoffs, where the problem is worst.

## Try it

- Live: https://lullabuy.tech (judges: /judge). Also at https://secondhand-safe-web.vercel.app.
- `curl "https://lullabuy.tech/api/check?model=BHC001&batch=202408"`
- MCP: `{"mcpServers":{"lullabuy":{"type":"http","url":"https://lullabuy.tech/api/mcp"}}}`

## Built with

TODO: tick only what is live on submission day. Live now: nextjs, typescript, visa-acceptance (sandbox),
visa-microform, trusted-agent-protocol, mcp, transformers.js, clip, scikit-learn, python, cpsc-api, nhtsa,
maplibre, vercel, playwright, github-actions, gemini (the recall pass is in the shipped index; the live label
reader needs a production key). Add elevenlabs once the production key is set. Add mongodb and solana only
if they are wired by then.
