# SecondHand Safe: Devpost draft (edit in your own voice before submitting)

> Numbers below are copied from `docs/FACTS.json` on 2026-09-26. If you regenerate FACTS, re-copy them.
> Lines marked TODO need you or Tylin. Delete any integration line that is not live when you submit.

## Tagline

See the recall before your money moves. SecondHand Safe holds a Visa payment until a camera reads the baby
gear's label.

## Inspiration

About 100 babies died in Fisher-Price Rock 'n Play sleepers, and at least 8 of those deaths happened after
the recall (CPSC, Jan 2023). This year Consumer Reports looked at secondhand marketplaces and found 50 of the
first 65 Facebook Marketplace listings it reviewed were banned infant in-bed sleepers, before it stopped
counting. Marketplaces filter what they can read in a listing. Nobody reads the label on the actual item
when the money changes hands in a parking lot.

TODO (Stephen): one or two sentences on why this one matters to you.

## What it does

1. **Agree and hold.** The buyer agrees on a price and SecondHand Safe asks Visa to authorize the card with
   capture off. The money is held, not sent.
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
- **Recall index:** 6036 CPSC recalls pulled from the CPSC API, 1137 kept as nursery and children's products,
  plus 71 NHTSA child restraint campaigns. Two hand checks of 20 records each found three extraction bugs,
  which we fixed and wrote up in `data/handcheck.md`.
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

## Challenges we ran into

- The model's first pass on real listings flagged crib skirts and dollhouse furniture. Reading every flag and
  feeding the mistakes back fixed most of it.
- Banned products are rare on eBay and Craigslist (eBay filters them out), so our test set had to be grouped
  by product instead of being made only of listing photos.
- Our first recall extraction turned phrases like "4-in-1" and years into model numbers. The listing scan
  exposed it.
- Payment states: an adversarial review found that a failed or replayed settlement could be shown as HELD.
  Now anything Visa did not confirm is shown as refused or unknown, never as a result.

## Accomplishments that we're proud of

- A real Visa hold that a camera settles, end to end, tested in a browser.
- A model that runs on the buyer's phone and was measured on products it had never seen.
- Every number on the site is recomputed by a script and served from an open endpoint.

## What we learned

TODO (Stephen and Tylin): write this one yourselves. Judges weigh it; do not leave it empty.

## What's next

- Seller-side confirmation of the scan (today the buyer's device reports it).
- Microform card entry, Trusted Agent Protocol for agent checkout, a deal board on MongoDB Atlas.
- Bring the check to Facebook Marketplace handoffs, where the problem is worst.

## Try it

- Live: https://secondhand-safe-web.vercel.app (judges: /judge)
- `curl "https://secondhand-safe-web.vercel.app/api/check?model=BHC001&batch=202408"`

## Built with

TODO: tick only what is live on submission day. Live now: nextjs, typescript, visa-acceptance (sandbox),
transformers.js, clip, scikit-learn, python, cpsc-api, nhtsa, maplibre, vercel, playwright, github-actions.
Add elevenlabs once the production key is set. Add gemini, mongodb, solana only if they are wired by then.
