import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { Nav } from "@/ui/Nav";
import { INDEX_SIZE, INDEX_AS_OF } from "@/server/recalls/match";
import { integrationStatus } from "@/server/env";
import { CopyLine } from "@/ui/CopyLine";
import { BRAND } from "@/core/brand";

export const metadata: Metadata = { title: `Judges: ${BRAND} in 3 minutes` };

const LIVE_LABEL: Record<string, string> = {
  visa: "Visa Acceptance sandbox (authorize, capture, reverse)",
  mongo: "MongoDB Atlas",
  gemini: "Gemini label reader",
  elevenlabs: "ElevenLabs spoken verdict",
  tap: "Trusted Agent Protocol signing key",
  solana: "Solana devnet passport",
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
    { t: "See the model's real scores", d: "Held-out products the model never saw. 1 of 107 ordinary items wrongly flagged, vs 38 for off-the-shelf CLIP.", code: `curl ${base}/api/stats`, link: "/#oracle", cta: "See the model section" },
    { t: "Hold real money, then settle it at pickup", d: live.visa
        ? "On /pickup, pick a listing and press Agree: a real Visa Acceptance sandbox authorization is created with capture off (HELD). Type BHC001 / 202408 and the hold is REVERSED at Visa; type any model with no recall and it is CAPTURED. The Visa ids are on screen."
        : "On /pickup the scan decides CAPTURE or REVERSE. The Visa hold itself needs sandbox keys on this deployment (see the live list below); it is verified by tests/visa.live.test.ts.",
      link: "/pickup", cta: "Open pickup scan" },
    { t: "See the Atlanta scan", d: "Every one of the 602 Craigslist Atlanta baby and kid listings we scanned, on a map, with what review found.", link: "/map", cta: "Open the map" },
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
