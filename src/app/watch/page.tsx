import type { Metadata } from "next";
import { connection } from "next/server";
import { Nav } from "@/ui/Nav";
import { BRAND } from "@/core/brand";
import { watchedSales } from "@/server/deals/store";
import { INDEX_AS_OF } from "@/server/recalls/match";
import { WatchSimulator } from "@/ui/WatchSimulator";

export const metadata: Metadata = { title: `Recall watch: ${BRAND}` };

/** Recall watch (PLAN 6.2): after the sale, the item is still watched. Live from MongoDB Atlas on every request. */
export default async function WatchPage() {
  await connection();
  const sales = await watchedSales();
  const flaggedCount = (sales ?? []).filter((s) => s.postSaleRecall).length;
  return (
    <>
      <Nav />
      <main className="px-3 pt-3 pb-3">
        <section className="section-card bg-sand px-5 sm:px-12 pt-28 pb-16">
          <p className="hand text-3xl text-ink/70 -rotate-2 mb-3">the check does not end at pickup</p>
          <h1 className="display text-[clamp(2.4rem,5.5vw,5rem)]">Recall watch</h1>
          <p className="mt-4 max-w-[46em] text-lg font-semibold">
            Recalls are announced after people have already bought the item. Every sale that passed the label check keeps
            the label it read, and is re-checked every day against the recall index (current index: {INDEX_AS_OF}). If a
            recall now matches, the sale is marked on its record and the buyer&apos;s browser gets a notification.
          </p>
          <div className="mt-8 grid sm:grid-cols-2 gap-4">
            <div className="rounded-[2rem] border-[3px] border-ink bg-paper p-5">
              <p className="display text-5xl">{sales ? sales.length : "?"}</p>
              <p className="font-bold">{sales ? "captured sales being watched" : "MongoDB Atlas did not answer"}</p>
            </div>
            <div className="rounded-[2rem] border-[3px] border-ink bg-paper p-5">
              <p className="display text-5xl">{flaggedCount}</p>
              <p className="font-bold">real recalls found after a sale so far</p>
            </div>
          </div>
          {/* ZZT9Q41X is the clean label on our demo table (the end-to-end test captures it too) */}
          <div className="mt-8"><WatchSimulator suggestions={["ZZT9Q41X"]} /></div>
          <p className="mt-6 text-sm font-semibold text-ink/70">
            To be notified yourself: complete a sale on /pickup and press &quot;Tell me if this item is ever recalled&quot;. Web Push works in
            Chrome, Edge and Firefox; on an iPhone, add Lullabuy to the Home Screen first. The sales here are our demo purchases and automated tests.
          </p>
        </section>
      </main>
    </>
  );
}
