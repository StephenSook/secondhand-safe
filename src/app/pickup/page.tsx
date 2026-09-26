import type { Metadata } from "next";
import { Nav } from "@/ui/Nav";
import { PickupScanner } from "@/ui/PickupScanner";

export const metadata: Metadata = { title: "Pickup scan: SecondHand Safe" };

export default function PickupPage() {
  return (
    <>
      <Nav />
      <main className="px-3 pt-3 pb-3">
        <section className="section-card bg-aqua-soft px-5 sm:px-12 pt-28 pb-16">
          <p className="hand text-3xl text-teal -rotate-2">at the curb, before any money moves</p>
          <h1 className="display text-[clamp(2.6rem,6vw,5.6rem)] mt-2">Pickup scan</h1>
          <p className="mt-4 max-w-[42em] text-lg font-semibold">
            Take one photo of the label. The barcode is read on your phone where the browser supports it, the label text by
            Gemini, and the product type by our model running in this browser. You can correct any field before the check.
          </p>
          <div className="mt-10"><PickupScanner /></div>
        </section>
      </main>
    </>
  );
}
