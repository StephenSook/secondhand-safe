import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { Nav } from "@/ui/Nav";
import { INDEX_SIZE, INDEX_AS_OF } from "@/server/recalls/match";
import { integrationStatus } from "@/server/env";
import { CopyLine } from "@/ui/CopyLine";
import { BRAND } from "@/core/brand";
import facts from "../../../docs/FACTS.json";

export const metadata: Metadata = { title: `Judges: ${BRAND} in 3 minutes` };

const LIVE_LABEL: Record<string, string> = {
  visa: "Visa Acceptance sandbox (authorize, capture, reverse, Microform, Token Management Service)",
  mongo: "MongoDB Atlas",
  gemini: "Gemini label reader",
  elevenlabs: "ElevenLabs spoken verdict",
  tap: "Trusted Agent Protocol signing key",
  solana: "Solana devnet passport",
  recallCall: "Recall phone call (Vonage Voice + ElevenLabs)",
};

/** The judge's door: no login, no key, every step runs against this deployment. */
export default async function JudgePage() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const base = `${proto}://${host}`;
  const live = integrationStatus();
  const steps = [
    { t: "Check a real recall yourself", d: "Open the live check and tap “Harppa high chair”. It is CPSC recall 26-061: model BHC001, recalled only in batch 202408.", link: "/#check", cta: "Open the live check" },
    { t: "Try the edge cases", d: "Same model, other batch: KEEP HELD, because the recall names one batch. OCR slip “BHCOO1”: still matches. An unknown model: NO_MATCH, and it never says “safe”.", link: "/#check", cta: "Try them" },
    { t: "Run it from your terminal", d: "Same index, no key:", code: `curl "${base}/api/check?model=BHC001&batch=202408"` },
    { t: "Give the check to an AI shopping agent", d: "The same check is an MCP tool, recall_check. Point any MCP client at this URL, or call it directly:", code: `curl -s ${base}/api/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recall_check","arguments":{"model":"BHC001","batch":"202408"}}}'` },
    { t: "See the model's real scores", d: `Held-out products the model never saw. ${facts.classifier.falseAlarmsOnOrdinary} of ${facts.classifier.ordinaryHeldOut} ordinary items wrongly flagged, vs ${facts.classifier.falseAlarmsZeroShot} for off-the-shelf CLIP.`, code: `curl ${base}/api/stats`, link: "/#oracle", cta: "See the model section" },
    { t: "Shop by voice or text", d: "Say “a bassinet for my newborn under $80, pickup in Atlanta”. Gemini reads the request, real listings come back pre-screened (red, amber, or photo check passed), and “Buy with our agent” places a Trusted Agent Protocol-signed Visa hold you then settle on /pickup.", link: "/shop", cta: "Open the shopping agent" },
    { t: "Hold real money, then settle it at pickup", d: live.visa
        ? "On /pickup, type Visa's sandbox test card (4111 1111 1111 1111, any CVV, a future expiry) into Visa's own Microform fields, pick a listing and press Agree: a real Visa Acceptance sandbox authorization is created with capture off (HELD). Type BHC001 / 202408 and the hold is REVERSED at Visa; type any model with no recall and it is CAPTURED. The Visa ids are on screen."
        : "On /pickup the scan decides CAPTURE or REVERSE. The Visa hold itself needs sandbox keys on this deployment (see the live list below); it is verified by tests/visa.live.test.ts.",
      link: "/pickup", cta: "Open pickup scan" },
    { t: "Get the item's passport", d: "When a clean label captures the payment, a Solana devnet transaction stores the SHA-256 of the pickup record (no personal data on chain). The passport page reads it back and checks the signer, the transaction and the hash.", link: "/pickup", cta: "Capture a clean deal on /pickup" },
    { t: "Pay again with a saved card", d: "Tick “Save this card with Visa” on the first hold. Next time, “Use my saved card” pays with Visa's Token Management Service; the card stays in Visa's vault. When Visa applies a card-linked offer, the hold is the discounted amount and the saving is shown.", link: "/pickup", cta: "Open pickup" },
    { t: "The phone app", d: "The same product as an iOS and Android app (Expo, built with EAS): shop, scan a label with the camera, and the deal board, all on this deployment's API. On Android, download and install the APK; the source is in mobile/.", link: "https://github.com/StephenSook/secondhand-safe/releases/tag/mobile-v1.0.0", cta: "Get the Android APK" },
    { t: "Settle it at the table kiosk", d: "After you press Agree on /pickup, open /checkpoint in the same tab: it picks up that hold. Scan the item's barcode with a USB scanner (it types like a keyboard), or type a UPC and press Enter. A recalled UPC, such as 669028116546 (CPSC 26-530), reverses the hold; a UPC with no recall captures it. One full-screen state, a sound per change, and a settlement made on another device shows up live.", link: "/checkpoint", cta: "Open the checkpoint" },
    { t: "Watch it from the seller's side", d: "After you press Agree on /pickup, a QR code appears. Scan it with a second phone: the seller's live view (MongoDB Atlas) follows the same deal to CAPTURED or REVERSED, with the reason. Every deal is also on the board.", link: "/board", cta: "Open the deal board" },
    { t: "See it as a marketplace's safety team would", d: "The Trust and Safety console: why holds were reversed (by the actual CPSC recall number), money that never reached a seller of a recalled item, time from hold to decision. Computed live from MongoDB Atlas; the deals are our demos and automated tests.", link: "/trust", cta: "Open the console" },
    { t: "Compare a photo with every recall photo", d: "MongoDB Atlas Vector Search over the CPSC recall photos: on /pickup your photo's embedding (computed in your browser) returns the three closest recall photos. Tested on held-out photos, and a resemblance is only ever a reason to read the label. Try a scanned listing:", code: `curl "${base}/api/lookalike?listingId=ebay:287601074532"` },
    { t: "See the Atlanta scan", d: `Every one of the ${facts.scannedAtlanta} Craigslist Atlanta baby and kid listings we scanned, on a map, with what review found.`, link: "/map", cta: "Open the map" },
    ...(live.recallCall ? [{ t: "Get the recall call", d: "On /pickup, after the hold, type your US phone number under “Call me if it's recalled”: Lullabuy phones you a 4-digit code, and you type it back. Then type BHC001 / 202408: Visa reverses the hold, and a few seconds later Lullabuy phones you and says, in the ElevenLabs voice, which CPSC recall matched and that you were not charged. Press 1 to hear it again. One call per deal, capped per day.", link: "/pickup", cta: "Open pickup" }] : []),
    { t: "Read the code", d: "Every number on this site is computed by a script in the repo. CI runs lint, types, tests, build, pytest, secret scan and an em-dash gate.", link: "https://github.com/StephenSook/secondhand-safe", cta: "GitHub" },
  ];
  return (
    <>
      <Nav />
      <main className="px-3 pt-3 pb-3">
        <section className="section-card bg-sand px-6 sm:px-12 pt-28 pb-16">
          <p className="hand text-3xl text-ink/70 -rotate-2">no login, no key, all live</p>
          <h1 className="display text-[clamp(2.8rem,6vw,6rem)] mt-2">Judges: three minutes</h1>
          <p className="mt-4 max-w-[40em] text-lg font-semibold">
            Recall index: {INDEX_SIZE.recalls.toLocaleString("en-US")} CPSC nursery and NHTSA child car seat recalls, {INDEX_SIZE.models.toLocaleString("en-US")} model
            numbers, as of {INDEX_AS_OF}. Health: <a className="underline font-bold" href="/api/health">/api/health</a>.
          </p>
          <ol className="mt-12 grid gap-5">
            {steps.map((s, i) => (
              <li key={s.t} className="rounded-[2rem] bg-paper border-[3px] border-ink p-6 shadow-[6px_8px_0_var(--ink)] grid sm:grid-cols-[4rem_1fr] gap-4">
                <span className="display text-5xl text-amber-deep">{i + 1}</span>
                <div>
                  <h2 className="display text-2xl">{s.t}</h2>
                  <p className="mt-2 font-semibold">{s.d}</p>
                  {s.code && <CopyLine text={s.code} />}
                  {s.link && (
                    <Link href={s.link} className="inline-block mt-3 font-extrabold underline decoration-[3px] underline-offset-4 decoration-amber">
                      {s.cta} →
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-12 rounded-[2rem] bg-ink text-paper p-6 sm:p-8">
            <h2 className="display text-3xl">What is live on this deployment right now</h2>
            <p className="mt-2 text-paper/70 font-semibold">Read from the server&apos;s configuration at page load. We only claim what is on.</p>
            <ul className="mt-5 grid sm:grid-cols-2 gap-3">
              <li className="flex items-center gap-3 font-bold"><span className="rounded-full bg-green px-2.5 py-0.5 text-xs">LIVE</span>CPSC recall index + matcher</li>
              <li className="flex items-center gap-3 font-bold"><span className="rounded-full bg-green px-2.5 py-0.5 text-xs">LIVE</span>Banned-type classifier results</li>
              {Object.entries(live).map(([k, on]) => (
                <li key={k} className="flex items-center gap-3 font-bold">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs ${on ? "bg-green" : "bg-paper/15 text-paper/70"}`}>{on ? "LIVE" : "NOT YET"}</span>
                  {LIVE_LABEL[k]}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
    </>
  );
}
