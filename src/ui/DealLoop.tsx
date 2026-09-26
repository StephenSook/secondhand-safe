"use client";

import { useRef } from "react";
import { setupGsap, useGSAP, gsap, prefersReducedMotion } from "./motion/gsap";

/**
 * The hero's deal card: HELD, then the label is scanned, then it resolves. It alternates the two real demo
 * outcomes: the Harppa high chair from real CPSC recall 26-061 is REVERSED; a label with no recall match is
 * CAPTURED (shown generically, never as an invented product).
 * Illustrative animation of the flow, labelled as such; the live check below runs the real index.
 */
export function DealLoop() {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      setupGsap();
      const q = gsap.utils.selector(root);
      if (prefersReducedMotion()) return;
      const outcome = (ok: boolean) => {
        const tl = gsap.timeline();
        tl.set(q(".dl-item"), { textContent: ok ? "Any item whose label has no recall match" : "Harppa high chair, model BHC001" })
          .set(q(".dl-model"), { textContent: ok ? "· · · · · ·" : "BHC001" })
          .set(q(".dl-batch"), { textContent: ok ? "· · · · · ·" : "202408" })
          .set(q(".dl-state"), { textContent: "HELD", backgroundColor: "var(--amber)", color: "var(--ink)" })
          .set(q(".dl-verdict"), { autoAlpha: 0, scale: 0.4, rotate: -18 })
          .set(q(".dl-bar"), { scaleX: 0 })
          .to(q(".dl-bar"), { scaleX: 1, duration: 1.4, ease: "none" }, 0.6)
          .fromTo(q(".dl-scan"), { top: "8%" }, { top: "86%", duration: 0.7, ease: "sine.inOut", repeat: 1, yoyo: true }, 0.6)
          .set(q(".dl-state"), ok
            ? { textContent: "CAPTURED", backgroundColor: "var(--green)", color: "var(--paper)" }
            : { textContent: "REVERSED", backgroundColor: "var(--red)", color: "var(--paper)" }, 2.1)
          .set(q(".dl-verdict"), { textContent: ok ? "NO MATCH" : "RECALL 26-061",
            color: ok ? "var(--green-deep)" : "var(--red-deep)" }, 2.1)
          .to(q(".dl-verdict"), { autoAlpha: 1, scale: 1, rotate: ok ? -6 : 8, duration: 0.7, ease: "elastic.out(1,0.6)" }, 2.1)
          .fromTo(q(".dl-card"), { rotate: 0 }, { rotate: ok ? -2 : 2, duration: 0.6, ease: "elastic.out(1,0.5)" }, 2.1)
          .to({}, { duration: 1.8 });
        return tl;
      };
      const master = gsap.timeline({ repeat: -1, delay: 1.2 });
      master.add(outcome(false)).add(outcome(true));
    },
    { scope: root },
  );

  return (
    <div ref={root} className="dl-card relative w-[min(22rem,82vw)] rounded-[2rem] border-[3px] border-ink bg-paper p-5 shadow-[10px_12px_0_var(--ink)] rotate-2">
      <div className="flex items-center justify-between text-sm font-bold">
        <span>Deal #0426 · pickup</span>
        <span className="dl-state rounded-full px-3 py-1 bg-amber text-ink font-extrabold tracking-wide">HELD</span>
      </div>
      <p className="display text-5xl mt-4">$64.00</p>
      <p className="dl-item mt-1 font-semibold text-ink/80">Harppa high chair, model BHC001</p>
      <div className="relative mt-4 h-40 rounded-2xl bg-sand border-2 border-ink overflow-hidden">
        <div className="absolute inset-4 rounded-lg bg-white border border-ink/30 p-3 font-mono text-[0.7rem] leading-4 text-ink/70">
          <p>MODEL NUMBER</p>
          <p className="dl-model text-ink font-bold text-sm">BHC001</p>
          <p className="mt-1">PRODUCTION BATCH</p>
          <p className="dl-batch text-ink font-bold text-sm">202408</p>
          <div className="absolute right-3 bottom-3 flex gap-[2px] h-8">
            {Array.from({ length: 22 }, (_, i) => (
              <span key={i} className="bg-ink" style={{ width: i % 3 === 0 ? 3 : 1.5 }} />
            ))}
          </div>
        </div>
        <div className="dl-scan absolute inset-x-2 h-1 bg-red shadow-[0_0_18px_4px_rgba(229,72,77,0.55)]" style={{ top: "8%" }} />
      </div>
      <div className="mt-4 h-2 rounded-full bg-ink/10 overflow-hidden">
        <div className="dl-bar h-full bg-ink origin-left scale-x-0" />
      </div>
      <p className="mt-2 text-xs font-semibold text-ink/60">Visa authorization held · checked at pickup</p>
      <span className="dl-verdict stamp absolute -top-5 -right-6 text-lg bg-paper opacity-0">RECALL 26-061</span>
      <p className="sr-only">Animated example: a payment is held, the label is scanned, then it is captured or reversed.</p>
    </div>
  );
}
