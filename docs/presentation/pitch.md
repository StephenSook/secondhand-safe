# Lullabuy: expo pitch and judge Q&A

Numbers come from `docs/FACTS.json` (as of 2026-09-26). Say them the way they are written here.

## The 90-second pitch (one person talks, the other drives the phone)

1. **Hook (10 s).** "About 100 babies died in one kind of infant sleeper, which is now recalled and banned.
   Banned sleepers are still for sale: Consumer Reports found 50 of the first 65 Facebook Marketplace listings
   it checked were banned in-bed sleepers."
2. **The gap (10 s).** "Marketplaces filter the words in a listing. Nobody reads the label when a parent hands a
   stranger money in a parking lot."
3. **What we built (10 s).** "Lullabuy holds the Visa payment until a camera has read the item's label."
4. **Demo: shop (20 s).** Open `/shop`, tap the mic, say "a bassinet for my newborn under 80 dollars, pickup in
   Atlanta". "Gemini reads the request. These are real listings, and every one was checked before we message a
   seller. Red ones, the agent will not buy." Tap "Buy with our agent". "Our agent signs that with Visa's
   Trusted Agent Protocol, and Visa holds the money. It is not paid yet."
5. **Demo: pickup (20 s).** Open the pickup scan, photograph the printed CPSC 26-061 label (the Harppa high
   chair prop). "Gemini reads the model and batch. That batch is recalled." The hold shows REVERSED at Visa,
   and the phone says why out loud. "The parent keeps their money and the recalled chair stays out of a nursery."
6. **Proof (10 s).** "Our photo model scored 0.72 macro-F1 on products it never saw, against 0.56 for
   off-the-shelf CLIP, and it wrongly flagged 2 ordinary items where CLIP flagged 38. Every number on the site
   is recomputed from the code."
7. **Close (10 s).** "Visa's auth-then-capture is how hotels and gas pumps already work. We pointed it at the
   one moment in secondhand baby gear where nobody was checking." Point at the QR codes.

## If they only have 30 seconds

"Buying used baby gear from a stranger? Lullabuy holds your Visa payment until your phone reads the label. A
recalled or banned item reverses the hold; a clean one pays the seller. Scan this and try it: no login."

## Things to have ready

- The printed CPSC 26-061 label (the recalled Harppa high chair, batch 202408) and one clean baby item.
- A phone on `/shop` and a second tab on `/pickup`. Laptop on `/judge`.
- The printed poster (`~/Desktop/Lullabuy-poster.pdf`).
- Get your badges scanned at every sponsor event (attendance counts, per the Ops Director).

## Judge questions, with honest answers

**Is the money real?** No. It is Visa's sandbox (apitest.cybersource.com), with the real Visa Acceptance APIs:
authorization with capture off, then a full capture or a full reversal. Production needs merchant underwriting.

**What does the AI actually decide?** Nothing about money on its own. Gemini turns the parent's words into
search filters and reads the label into fields. The decision comes from the CPSC and NHTSA recall index, our
trained photo model, and our own review of flagged photos. The app never calls anything "safe".

**How good is the model?** Macro-F1 0.72 (95% CI 0.60 to 0.81) on products it never saw, against 0.56 for
off-the-shelf CLIP. On ordinary baby items it wrongly flagged 2 of 107, CLIP flagged 38. The test set is split
by product so no recall or listing appears on both sides.

**What if the model is wrong?** A wrong guess keeps the hold ("needs a check"); it never pays out on a guess.
Only a clean label read captures. A model number that several brands share (like "4340") never moves money
until a person confirms the brand.

**Is the Trusted Agent Protocol real?** We implemented it: RFC 9421 HTTP Message Signatures with Ed25519,
covering the method, host, path and a digest of the body, with a one-time nonce and an 8-minute window. Our
merchant checks it before calling Visa. Show the tampered request being refused on `/pickup`. It proves the
agent is ours and the request was not changed; it does not prove a parent approved the amount (that is Visa
Intelligent Commerce, which is invite-only and we do not claim).

**Who pays for this?** The marketplace or payment platform, per protected transaction: it avoids disputes over
recalled items and keeps banned products off its platform. (We do not have a verified per-dispute cost figure,
so do not quote one.)

**Where does the listing data come from?** 1,662 real public eBay and Craigslist listings we harvested and
scanned on 2026-09-26. Facebook Marketplace is not scraped (their terms forbid it).

**What is still open?** The buyer's phone reports the scan today; a seller-side confirmation needs a shared
store. The Solana item passport is built but waits on devnet funds. The recall index is as of its build date.

**Can I check it myself?** Yes. `curl ".../api/check?model=BHC001&batch=202408"`, or connect any MCP client to
`/api/mcp` and call `recall_check`. The code is public.
