import type { Metadata } from "next";
import { Nav } from "@/ui/Nav";
import { Atlas } from "@/ui/Atlas";

export const metadata: Metadata = { title: "The model's view: SecondHand Safe" };

export default function AtlasPage() {
  return (
    <>
      <Nav />
      <main className="px-3 pt-3 pb-3">
        <section className="section-card bg-sand px-5 sm:px-12 pt-28 pb-12">
          <p className="hand text-3xl text-ink/70 -rotate-2 mb-6">what the model sees</p>
          <h1 className="display text-[clamp(2.6rem,6vw,5.6rem)]">The model&apos;s view</h1>
          <p className="mt-4 max-w-[44em] text-lg font-semibold">
            Every photo the model has looked at, placed so similar-looking products sit together. Drop-side cribs and
            crib bumpers form their own neighborhoods. Infant sleepers are scattered among ordinary baby gear, which is
            why they are the model&apos;s hardest class and why the label check at pickup, not the photo, has the last word.
            Click a color to isolate it.
          </p>
          <div className="mt-8"><Atlas /></div>
        </section>
      </main>
    </>
  );
}
