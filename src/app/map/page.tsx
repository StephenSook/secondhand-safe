import type { Metadata } from "next";
import { Nav } from "@/ui/Nav";
import { ScanMap } from "@/ui/ScanMap";
import { BRAND } from "@/core/brand";

export const metadata: Metadata = { title: `The Atlanta scan: ${BRAND}` };

export default function MapPage() {
  return (
    <>
      <Nav />
      <main className="px-3 pt-3 pb-3">
        <section className="section-card bg-aqua-soft px-5 sm:px-12 pt-28 pb-12">
          <p className="hand text-3xl text-teal -rotate-2 mb-6">every dot is a real listing</p>
          <h1 className="display text-[clamp(2.6rem,6vw,5.6rem)]">The Atlanta scan</h1>
          <p className="mt-4 max-w-[44em] text-lg font-semibold">
            We ran every baby and kid listing Craigslist Atlanta showed us through the same model the pickup scan uses, and
            read every flag by eye. Click a dot to see what the model saw.
          </p>
          <div className="mt-8"><ScanMap /></div>
        </section>
      </main>
    </>
  );
}
