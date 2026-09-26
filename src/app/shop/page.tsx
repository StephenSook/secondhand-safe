import type { Metadata } from "next";
import { Nav } from "@/ui/Nav";
import { ShopAgent } from "@/ui/ShopAgent";
import { BRAND } from "@/core/brand";
import { CATALOG } from "@/server/shop/catalog";

export const metadata: Metadata = { title: `Shop with the agent: ${BRAND}` };

export default function ShopPage() {
  return (
    <>
      <Nav />
      <main className="px-3 pt-3 pb-3">
        <section className="section-card bg-amber-soft px-5 sm:px-12 pt-28 pb-16">
          <p className="hand text-3xl text-ink/70 -rotate-2 mb-4">say it like you would to a friend</p>
          <h1 className="display text-[clamp(2.6rem,6vw,5.6rem)] mt-2">Shop with the agent</h1>
          <p className="mt-4 max-w-[44em] text-lg font-semibold">
            Tell it what you need. Gemini turns your words into a search over {CATALOG.length.toLocaleString()} real
            marketplace listings, every result is checked for recalls and banned product types before you message a
            seller, and our agent can place a signed Visa hold that only turns into a payment once the label passes at
            pickup.
          </p>
          <div className="mt-10"><ShopAgent /></div>
        </section>
      </main>
    </>
  );
}
