import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Nav } from "@/ui/Nav";
import { BRAND } from "@/core/brand";
import { ANDROID_PATH, testflightUrl } from "@/core/install";

export const metadata: Metadata = { title: `${BRAND} for iPhone` };
// read TESTFLIGHT_PUBLIC_URL per request, so setting it on the deployment takes effect without a rebuild
export const dynamic = "force-dynamic";

/** GET /get/ios: straight to the public TestFlight link when one is configured, otherwise an honest status page. */
export default function IosPage() {
  const tf = testflightUrl();
  if (tf) redirect(tf);
  return (
    <>
      <Nav />
      <main className="px-3 pt-3 pb-3">
        <section className="section-card bg-sand px-6 sm:px-12 pt-28 pb-16">
          <p className="hand text-3xl text-ink/70 -rotate-2">on your iPhone</p>
          <h1 className="display text-[clamp(2.6rem,6vw,5.6rem)] mt-2">{BRAND} for iPhone is in TestFlight.</h1>
          <p className="mt-4 max-w-[40em] text-lg font-semibold">
            The public TestFlight link is waiting on Apple&apos;s beta review, so it is not open yet. You can use {BRAND} on
            your iPhone right now in Safari: the web app runs the same checks on the same live API.
          </p>
          <ol className="mt-10 grid gap-5 max-w-[48rem]">
            <li className="rounded-[2rem] bg-paper border-[3px] border-ink p-6 shadow-[6px_8px_0_var(--ink)]">
              <h2 className="display text-2xl">Open the web app</h2>
              <p className="mt-2 font-semibold">lullabuy.tech/pickup works in Safari on iPhone: take a photo of the label and run the recall check.</p>
              <Link href="/pickup" className="inline-block mt-4 rounded-full bg-amber border-[3px] border-ink px-6 py-3 font-extrabold text-lg">
                Open the pickup scan →
              </Link>
            </li>
            <li className="rounded-[2rem] bg-paper border-[3px] border-ink p-6 shadow-[6px_8px_0_var(--ink)]">
              <h2 className="display text-2xl">On Android?</h2>
              <p className="mt-2 font-semibold">The Android app is ready to install as an APK.</p>
              <a href={ANDROID_PATH} className="inline-block mt-3 font-extrabold underline decoration-[3px] underline-offset-4 decoration-amber">
                Get the Android APK →
              </a>
            </li>
          </ol>
        </section>
      </main>
    </>
  );
}
