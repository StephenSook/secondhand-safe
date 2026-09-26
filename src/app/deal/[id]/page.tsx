import type { Metadata } from "next";
import { Nav } from "@/ui/Nav";
import { DealLive } from "@/ui/DealLive";
import { BRAND } from "@/core/brand";

export const metadata: Metadata = { title: `Deal: ${BRAND}` };

/** Opened on the seller's phone by scanning the QR on the buyer's pickup screen. */
export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <Nav />
      <main className="px-3 pt-3 pb-3">
        <section className="section-card bg-aqua-soft px-5 sm:px-12 pt-28 pb-16">
          <p className="hand text-3xl text-teal -rotate-2 mb-3">the seller&apos;s side of the same deal</p>
          <h1 className="display text-[clamp(2.2rem,5vw,4.6rem)]">Deal status</h1>
          <DealLive dealId={id} />
        </section>
      </main>
    </>
  );
}
