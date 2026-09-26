"use client";

import { useRef } from "react";
import { setupGsap, useGSAP, gsap, SplitText, prefersReducedMotion } from "./motion/gsap";
import { WaveBlobs } from "./WaveBlobs";
import { SquashButton } from "./SquashButton";
import { DealLoop } from "./DealLoop";
import { FloatingGear } from "./FloatingGear";

export function Hero({ recalls }: { recalls: number }) {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    (_ctx, contextSafe) => {
      setupGsap();
      const q = gsap.utils.selector(root);
      if (prefersReducedMotion()) return;
      // contextSafe: tweens made in the event callback belong to this context and are reverted with it, so
      // StrictMode's double mount cannot stack two "from opacity 0" tweens (the second would animate 0 to 0).
      const run = contextSafe!(() => {
        const split = new SplitText(q(".hero-title"), { type: "words" });
        const tl = gsap.timeline();
        tl.set(q("[data-reveal]"), { visibility: "visible" })
          .fromTo(q(".hero-bg"), { clipPath: "ellipse(20% 0% at 100% 100%)" },
            { clipPath: "ellipse(150% 130% at 100% 100%)", duration: 1.1, ease: "circ.out" }, 0)
          .from(split.words, {
            transformOrigin: "top left", yPercent: -10, xPercent: 40, scaleY: 0.1, scaleX: 0.85, rotate: 8, opacity: 0,
            duration: 0.875, ease: "elastic.out(1,0.72)", stagger: 0.088,
          }, 0.2)
          .from(q(".hero-sub"), { y: "-0.75em", opacity: 0, duration: 0.35, ease: "energy" }, 0.65)
          .from(q(".hero-cta > *"), { y: "-0.75em", opacity: 0, duration: 0.35, ease: "energy", stagger: 0.08 }, 0.75)
          .from(q(".hero-note"), { scale: 0, rotate: -30, opacity: 0, duration: 0.8, ease: "elastic.out(1,0.72)", stagger: 0.15 }, 0.9)
          .from(q(".hero-deal"), { yPercent: 40, rotate: 14, scale: 0.8, opacity: 0, duration: 1.1, ease: "elastic.out(1,0.75)" }, 0.5);
      });
      if (document.querySelector(".pl-path")) {
        window.addEventListener("shs:intro-done", run, { once: true });
        return () => window.removeEventListener("shs:intro-done", run);
      }
      run();
    },
    { scope: root },
  );

  return (
    <section ref={root} className="relative px-3 pt-3">
      <div className="hero-bg section-card bg-amber min-h-[100svh] flex items-center">
        <WaveBlobs tints={["#ffc445", "#ffd66e", "#ffe7b0"]} />
        <div className="relative z-10 w-full grid lg:grid-cols-[1.25fr_1fr] gap-10 items-center px-6 sm:px-12 pt-28 pb-16">
          <div>
            <p data-reveal className="hero-note hand text-3xl text-ink -rotate-3 mb-4 inline-block">
              for the parent meeting a stranger in a parking lot
            </p>
            <h1 data-reveal className="hero-title display text-[clamp(3rem,7.4vw,7.6rem)] text-ink">
              The money doesn&apos;t move until the camera has seen the item.
            </h1>
            <p data-reveal className="hero-sub mt-6 max-w-[34em] text-lg font-semibold text-ink/85">
              Buying a used crib or car seat? Your Visa payment is <b>held</b>, not sent. At pickup, your phone
              reads the label and scans the barcode against {recalls.toLocaleString("en-US")} real CPSC
              and NHTSA recalls and the banned product types. Clean: the seller gets paid. Recalled or banned: the hold is
              reversed and nobody takes the risk home.
            </p>
            <div data-reveal className="hero-cta mt-8 flex flex-wrap gap-3">
              <SquashButton href="/shop" bg="var(--visa)" accent="var(--amber)">Shop with the agent</SquashButton>
              <SquashButton href="/#check" accent="var(--green)">Try a live recall check</SquashButton>
              <SquashButton href="/judge" bg="var(--paper)" fg="var(--ink)" accent="var(--pink)">Judges start here</SquashButton>
            </div>
          </div>
          <div data-reveal className="hero-deal relative justify-self-center">
            <FloatingGear />
            <DealLoop />
            <p className="hero-note hand text-2xl text-ink absolute -left-10 -bottom-10 rotate-[-8deg] max-w-[9em]">
              a Visa hold, not a promise
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
