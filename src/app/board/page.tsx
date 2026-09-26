import type { Metadata } from "next";
import { Nav } from "@/ui/Nav";
import { DealBoard } from "@/ui/DealBoard";
import { BRAND } from "@/core/brand";

export const metadata: Metadata = { title: `Deal board: ${BRAND}` };

export default function BoardPage() {
  return (
    <>
      <Nav />
      <main className="px-3 pt-3 pb-3">
        <section className="section-card bg-sand px-5 sm:px-12 pt-28 pb-16">
          <p className="hand text-3xl text-ink/70 -rotate-2 mb-3">every hold, and how it ended</p>
          <h1 className="display text-[clamp(2.4rem,5.5vw,5rem)]">Deal board</h1>
          <DealBoard />
        </section>
      </main>
    </>
  );
}
