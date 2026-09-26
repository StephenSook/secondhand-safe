"use client";

import { useRef } from "react";
import { setupGsap, useGSAP, gsap } from "./motion/gsap";
import { Mark } from "./Mark";
import { SquashButton } from "./SquashButton";

/** Footer slides out from under the section above while the tag swings in (reference: footer parallax). */
export function Footer() {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      setupGsap();
      const mm = gsap.matchMedia();
      mm.add("(min-width: 992px) and (prefers-reduced-motion: no-preference)", () => {
        const q = gsap.utils.selector(root);
        const tl = gsap.timeline({ scrollTrigger: { trigger: root.current, start: "clamp(top bottom)", end: "clamp(top top)", scrub: 0.2 } });
        tl.from(q(".ft-row"), { y: "-12.5em", ease: "none" }, 0)
          .from(q(".ft-tag"), { scale: 0.9, xPercent: -35, y: "17.5em", rotate: 30, ease: "none" }, 0);
      });
    },
    { scope: root },
  );
  return (
    <footer ref={root} className="relative px-3 pt-3 pb-3 mt-3">
      <div className="section-card bg-ink text-paper px-6 sm:px-12 py-20 overflow-hidden">
        <div className="ft-row grid lg:grid-cols-[1.4fr_1fr] gap-12 items-end">
          <div>
            <h2 className="display text-[clamp(2.6rem,6vw,6rem)]">Hold the money. Read the label.</h2>
            <div className="mt-8 flex flex-wrap gap-3">
              <SquashButton href="/judge" accent="var(--amber)" bg="var(--paper)" fg="var(--ink)">Judges start here</SquashButton>
              <SquashButton href="https://github.com/StephenSook/secondhand-safe" accent="var(--aqua)" bg="var(--ink-soft)">Read the code</SquashButton>
            </div>
          </div>
          <div className="ft-tag justify-self-end rotate-[-6deg] rounded-[2rem] bg-green text-paper border-[3px] border-paper p-6 w-[16rem] shadow-[8px_10px_0_rgba(0,0,0,0.35)]">
            <p className="font-extrabold tracking-widest text-sm">STATUS</p>
            <p className="display text-5xl mt-1">CAPTURED</p>
            <p className="hand text-2xl mt-2">label read, no recall match</p>
          </div>
        </div>
        <div className="ft-row mt-16 pt-8 border-t border-paper/20 flex flex-wrap items-center justify-between gap-6 text-sm font-semibold text-paper/70">
          <div className="flex items-center gap-3"><Mark size={36} /><span>SecondHand Safe · HackGT 13 · Stephen Sookra and Tylin</span></div>
          <p>
            {/* Wired-or-cut: name an integration here only once it is live on this deployment. */}
            Recall data: <a className="underline" href="https://www.saferproducts.gov/" target="_blank" rel="noreferrer">CPSC recall API</a>
          </p>
        </div>
      </div>
    </footer>
  );
}
