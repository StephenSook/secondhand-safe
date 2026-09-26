"use client";

import { useRef } from "react";
import { setupGsap, useGSAP, gsap, prefersReducedMotion } from "./motion/gsap";
import { WaveBlobs } from "./WaveBlobs";

/** Every number here is quoted from the linked primary source (checked 2026-09-26). */
const STATS = [
  {
    big: "~100",
    line: "infant deaths reported in Rock 'n Play sleepers. At least 8 happened after the 2019 recall.",
    src: "CPSC, Jan 9 2023",
    href: "https://www.cpsc.gov/Recalls/2023/Fisher-Price-Reannounces-Recall-of-4-7-Million-Rock-n-Play-Sleepers-At-Least-Eight-Deaths-Occurred-After-Recall",
    rot: -4,
  },
  {
    big: "50 of 65",
    line: "Facebook Marketplace listings Consumer Reports reviewed were banned infant in-bed sleepers. Then they stopped counting.",
    src: "Consumer Reports, 2026",
    href: "https://advocacy.consumerreports.org/press_release/banned-unsafe-baby-products-still-for-sale-on-popular-secondhand-marketplaces-consumer-reports-evaluation-finds/",
    rot: 3,
  },
  {
    big: "4.7M",
    line: "Rock 'n Play sleepers under recall. Recalled units keep getting resold, because nobody checks the label when cash changes hands.",
    src: "CPSC, Jan 9 2023",
    href: "https://www.cpsc.gov/Recalls/2023/Fisher-Price-Reannounces-Recall-of-4-7-Million-Rock-n-Play-Sleepers-At-Least-Eight-Deaths-Occurred-After-Recall",
    rot: -2,
  },
];

export function Problem() {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      setupGsap();
      if (prefersReducedMotion()) return;
      const q = gsap.utils.selector(root);
      gsap.from(q(".pb-stamp"), {
        scale: 0, rotate: -20, y: "-4em", opacity: 0, duration: 0.9, ease: "elastic.out(1,0.72)", stagger: 0.14,
        scrollTrigger: { trigger: root.current, start: "top 70%", once: true },
      });
      gsap.from(q(".pb-title"), { yPercent: 60, opacity: 0, duration: 0.8, ease: "elastic.out(1,0.75)",
        scrollTrigger: { trigger: root.current, start: "top 80%", once: true } });
    },
    { scope: root },
  );
  return (
    <section ref={root} className="relative px-3 mt-3" aria-labelledby="problem-title">
      <div className="section-card bg-red-soft px-6 sm:px-12 py-24">
        <WaveBlobs tints={["#ffc9c6", "#ffb7b3", "#ffa39e"]} className="opacity-60" />
        <div className="relative z-10">
          <p className="hand text-3xl text-red-deep -rotate-2 mb-7">why this exists</p>
          <h2 id="problem-title" className="pb-title display text-[clamp(2.6rem,5.4vw,5.4rem)] mt-2 max-w-[14em]">
            Listing filters read the text. Nobody reads the label.
          </h2>
          <div className="mt-14 grid md:grid-cols-3 gap-8">
            {STATS.map((s) => (
              <a key={s.big + s.src} href={s.href} target="_blank" rel="noreferrer"
                className="pb-stamp group block rounded-[2rem] border-[3px] border-ink bg-paper p-7 shadow-[8px_10px_0_var(--ink)] transition-transform hover:-translate-y-1"
                style={{ rotate: `${s.rot}deg` }}>
                <p className="display text-[clamp(3.2rem,5vw,4.6rem)] text-red-deep">{s.big}</p>
                <p className="mt-3 text-lg font-semibold leading-snug">{s.line}</p>
                <p className="mt-5 text-sm font-bold text-ink/60 group-hover:text-ink underline decoration-2 underline-offset-4">
                  Source: {s.src} ↗
                </p>
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
