"use client";

import { useRef } from "react";
import { setupGsap, useGSAP, gsap, prefersReducedMotion } from "./motion/gsap";
import { WaveBlobs } from "./WaveBlobs";

export type OracleData = {
  heldOut: number;
  train: number;
  macroF1: number;
  ci: number[];
  zeroShotF1: number;
  falseTrained: number;
  falseZero: number;
  ordinaryN: number;
  perClass: Record<string, { precision: number; recall: number; f1: number; n: number }>;
  confusion: number[][];
  listings: number;
  cpscPhotos: number;
  labels: number;
};

const NAMES: Record<string, string> = {
  inclined_or_inbed_sleeper: "Inclined / in-bed sleeper",
  crib_bumper: "Crib bumper",
  drop_side_crib: "Drop-side crib",
  other: "Everything else",
};

/** The Oracle of the Deep section: a model that sees the product type a listing's text hides. */
export function Oracle({ d }: { d: OracleData }) {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      setupGsap();
      if (prefersReducedMotion()) return;
      const q = gsap.utils.selector(root);
      gsap.from(q(".or-cell"), { scale: 0, opacity: 0, duration: 0.6, ease: "elastic.out(1,0.7)",
        stagger: { each: 0.03, from: "start" }, scrollTrigger: { trigger: q(".or-matrix")[0], start: "top 80%", once: true } });
      gsap.from(q(".or-big"), { scale: 0, rotate: -20, opacity: 0, duration: 0.9, ease: "elastic.out(1,0.72)", stagger: 0.15,
        scrollTrigger: { trigger: q(".or-bigs")[0], start: "top 80%", once: true } });
      q(".or-bar").forEach((el: Element) => gsap.from(el, { scaleX: 0, transformOrigin: "left center", duration: 1, ease: "elastic.out(1,0.8)",
        scrollTrigger: { trigger: el, start: "top 90%", once: true } }));
    },
    { scope: root },
  );
  const classes = Object.keys(NAMES);
  const max = Math.max(...d.confusion.flat());
  return (
    <section ref={root} id="oracle" className="relative px-3 mt-3 scroll-mt-20" aria-labelledby="oracle-title">
      <div className="section-card bg-teal text-paper px-6 sm:px-12 py-24">
        <WaveBlobs tints={["#127b7b", "#168a89", "#1c9a98"]} className="opacity-70" />
        <div className="relative z-10">
          <p className="hand text-3xl text-aqua -rotate-2 mb-4">sees what the listing text hides</p>
          <h2 id="oracle-title" className="display text-[clamp(2.6rem,5.4vw,5.4rem)] mt-2 max-w-[13em]">
            A model that knows a banned product on sight
          </h2>
          <p className="mt-5 max-w-[42em] text-lg font-semibold text-paper/85">
            Sellers rename things. A &ldquo;baby nest&rdquo; is an in-bed sleeper; &ldquo;crib bedding set&rdquo; can hide a bumper. We harvested {d.listings.toLocaleString("en-US")} real
            marketplace listings and {d.cpscPhotos} CPSC recall photos, reviewed {d.labels} labels one by one on numbered contact sheets, and trained a head on
            CLIP image embeddings. It is tested on {d.heldOut} photos of products it has never seen: no recall and no listing sits on both sides.
          </p>

          <div className="or-bigs mt-12 grid md:grid-cols-3 gap-6">
            <div className="or-big rounded-[2rem] bg-paper text-ink border-[3px] border-ink p-6 shadow-[8px_10px_0_var(--ink)] -rotate-2">
              <p className="display text-6xl text-green-deep">{d.falseTrained} <span className="text-3xl">of {d.ordinaryN}</span></p>
              <p className="mt-2 font-bold">ordinary baby items wrongly flagged by our model</p>
            </div>
            <div className="or-big rounded-[2rem] bg-paper text-ink border-[3px] border-ink p-6 shadow-[8px_10px_0_var(--ink)] rotate-2">
              <p className="display text-6xl text-red-deep">{d.falseZero} <span className="text-3xl">of {d.ordinaryN}</span></p>
              <p className="mt-2 font-bold">wrongly flagged by off-the-shelf CLIP. A pre-screen that cries wolf gets ignored.</p>
            </div>
            <div className="or-big rounded-[2rem] bg-amber text-ink border-[3px] border-ink p-6 shadow-[8px_10px_0_var(--ink)] -rotate-1">
              <p className="display text-6xl">{d.macroF1.toFixed(2)}</p>
              <p className="mt-2 font-bold">macro-F1 on held-out products (95% CI {d.ci[0].toFixed(2)} to {d.ci[1].toFixed(2)}), vs {d.zeroShotF1.toFixed(2)} zero-shot</p>
            </div>
          </div>

          <div className="mt-14 grid lg:grid-cols-2 gap-10 items-start">
            <div>
              <h3 className="display text-3xl">Per class, on unseen products</h3>
              <ul className="mt-5 space-y-4">
                {classes.map((c) => (
                  <li key={c}>
                    <div className="flex justify-between font-bold"><span>{NAMES[c]}</span><span>n={d.perClass[c].n}</span></div>
                    <div className="mt-1.5 space-y-1">
                      <div className="h-3 rounded-full bg-paper/15 overflow-hidden"><div className="or-bar h-full bg-aqua" style={{ width: `${d.perClass[c].precision * 100}%` }} /></div>
                      <div className="h-3 rounded-full bg-paper/15 overflow-hidden"><div className="or-bar h-full bg-amber" style={{ width: `${d.perClass[c].recall * 100}%` }} /></div>
                    </div>
                    <p className="text-sm text-paper/70 mt-1">precision {d.perClass[c].precision.toFixed(2)} · recall {d.perClass[c].recall.toFixed(2)}</p>
                  </li>
                ))}
              </ul>
              <p className="hand text-2xl text-aqua mt-6 rotate-1">high precision, modest recall: it is a pre-screen. The label check at pickup decides.</p>
            </div>
            <div>
              <h3 className="display text-3xl">Confusion matrix</h3>
              <div className="or-matrix mt-5 grid grid-cols-[7rem_repeat(4,1fr)] gap-1.5 text-sm font-bold" role="table" aria-label="Confusion matrix, rows are true class, columns are predicted class">
                <span />
                {classes.map((c) => <span key={c} className="text-center text-paper/70 text-xs leading-tight" role="columnheader">{NAMES[c]}</span>)}
                {d.confusion.map((row, i) => (
                  <div key={i} className="contents" role="row">
                    <span className="text-xs leading-tight self-center text-paper/70" role="rowheader">{NAMES[classes[i]]}</span>
                    {row.map((v, j) => (
                      <span key={j} role="cell"
                        className={`or-cell aspect-square grid place-items-center rounded-xl text-lg ${i === j ? "text-ink" : "text-paper"}`}
                        style={{ background: i === j ? `color-mix(in srgb, var(--green) ${30 + (70 * v) / max}%, var(--paper))` : v ? `color-mix(in srgb, var(--red) ${25 + (75 * v) / max}%, transparent)` : "rgba(255,255,255,0.06)" }}>
                        {v}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
              <p className="text-sm text-paper/70 mt-3">Rows: true class. Columns: model&apos;s answer. Numbers read live from <code>/api/stats</code>.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
