"use client";

import { useRef, useState } from "react";
import type { Verdict } from "@/core/verdict";
import { VERDICT_LABEL } from "@/core/verdict";
import { setupGsap, gsap, prefersReducedMotion } from "./motion/gsap";
import { SquashButton } from "./SquashButton";

/** Real label values from real CPSC recalls, plus two that show the edge rules. */
const SAMPLES = [
  { label: "Harppa high chair", model: "BHC001", batch: "202408", note: "CPSC 26-061" },
  { label: "Same model, other batch", model: "BHC001", batch: "202511", note: "batch rule" },
  { label: "AirClub bassinet", model: "QX-831", batch: "", note: "CPSC 26-342" },
  { label: "OCR slip: BHCOO1", model: "BHCOO1", batch: "202408", note: "O vs 0" },
  { label: "No recall on file", model: "ZZT9Q41X", batch: "", note: "never 'safe'" },
];

/** Wall-clock helper kept outside the component: it only runs in event handlers, never during render. */
const clock = () => performance.now();

const TONE: Record<Verdict["kind"], { bg: string; ink: string; word: string }> = {
  RECALL_MATCH: { bg: "bg-red-soft", ink: "text-red-deep", word: "REVERSE" },
  BANNED_TYPE: { bg: "bg-red-soft", ink: "text-red-deep", word: "REVERSE" },
  NO_MATCH: { bg: "bg-green-soft", ink: "text-green-deep", word: "CAPTURE" },
  NEEDS_CHECK: { bg: "bg-amber-soft", ink: "text-ink", word: "KEEP HELD" },
  UNREADABLE: { bg: "bg-sand", ink: "text-ink", word: "KEEP HELD" },
};

export function LiveCheck() {
  const [model, setModel] = useState("");
  const [batch, setBatch] = useState("");
  const [upc, setUpc] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ verdict: Verdict; ms: number } | null>(null);
  const [err, setErr] = useState("");
  const stampRef = useRef<HTMLSpanElement>(null);

  async function run(m = model, b = batch, u = upc) {
    setBusy(true);
    setErr("");
    const t0 = clock();
    try {
      const r = await fetch("/api/check", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: m, batch: b, upc: u }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { verdict: Verdict };
      setRes({ verdict: j.verdict, ms: Math.round(clock() - t0) });
      requestAnimationFrame(() => {
        if (prefersReducedMotion() || !stampRef.current) return;
        setupGsap();
        gsap.fromTo(stampRef.current, { scale: 0, rotate: -24, opacity: 0 },
          { scale: 1, rotate: -5, opacity: 1, duration: 0.8, ease: "elastic.out(1,0.6)" });
        gsap.to(stampRef.current.querySelector(".lc-word"), {
          duration: 0.6, scrambleText: { text: VERDICT_LABEL[j.verdict.kind].toUpperCase(), chars: "XO01#", speed: 0.6 } });
      });
    } catch (e) {
      setErr(`The check did not run: ${(e as Error).message}. Nothing was decided.`);
      setRes(null);
    } finally {
      setBusy(false);
    }
  }

  const v = res?.verdict;
  const tone = v ? TONE[v.kind] : null;
  return (
    <section id="check" className="relative px-3 mt-3 scroll-mt-20" aria-labelledby="check-title">
      <div className="section-card bg-ink text-paper px-6 sm:px-12 py-24">
        <p className="hand text-3xl text-amber -rotate-2 mb-7">try it, it is the real index</p>
        <h2 id="check-title" className="display text-[clamp(2.6rem,5.4vw,5.4rem)] mt-2">Live recall check</h2>
        <p className="mt-4 max-w-[40em] font-semibold text-paper/80">
          Type what is printed on the label, or plug in a USB barcode scanner and scan the UPC. This calls the same
          <code className="mx-1 rounded bg-paper/10 px-1.5 py-0.5">/api/check</code> the pickup scan uses.
        </p>
        <div className="mt-10 grid lg:grid-cols-[1fr_1.1fr] gap-10 items-start">
          <form className="rounded-[2rem] bg-paper text-ink border-[3px] border-amber p-6 sm:p-8"
            onSubmit={(e) => { e.preventDefault(); run(); }}>
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="block font-bold">Model number
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. BHC001" autoComplete="off"
                  className="mt-1 w-full rounded-xl border-2 border-ink px-4 py-3 font-mono text-lg uppercase focus:outline-none focus:ring-4 focus:ring-amber" />
              </label>
              <label className="block font-bold">Batch / lot / date code
                <input value={batch} onChange={(e) => setBatch(e.target.value)} placeholder="optional" autoComplete="off"
                  className="mt-1 w-full rounded-xl border-2 border-ink px-4 py-3 font-mono text-lg uppercase focus:outline-none focus:ring-4 focus:ring-amber" />
              </label>
              <label className="block font-bold sm:col-span-2">UPC (barcode scanners type here)
                <input value={upc} onChange={(e) => setUpc(e.target.value)} placeholder="scan or type 12 digits" inputMode="numeric" autoComplete="off"
                  className="mt-1 w-full rounded-xl border-2 border-ink px-4 py-3 font-mono text-lg focus:outline-none focus:ring-4 focus:ring-amber" />
              </label>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <SquashButton type="submit" disabled={busy} accent="var(--amber)">{busy ? "Checking…" : "Check the label"}</SquashButton>
            </div>
            <p className="mt-6 text-sm font-bold text-ink/60">Or try a real recall:</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {SAMPLES.map((s) => (
                <button key={s.label} type="button"
                  onClick={() => { setModel(s.model); setBatch(s.batch); setUpc(""); run(s.model, s.batch, ""); }}
                  className="rounded-full border-2 border-ink bg-amber-soft px-3 py-1.5 text-sm font-bold hover:bg-amber hover:-rotate-2 transition-transform">
                  {s.label} <span className="text-ink/50">· {s.note}</span>
                </button>
              ))}
            </div>
          </form>

          <div aria-live="polite" className="min-h-[20rem]">
            {err && <p className="rounded-2xl bg-red-soft text-red-deep p-5 font-bold">{err}</p>}
            {!v && !err && (
              <div className="h-full grid place-items-center rounded-[2rem] border-[3px] border-dashed border-paper/30 p-10 text-center">
                <p className="hand text-3xl text-paper/60">your verdict lands here</p>
              </div>
            )}
            {v && tone && (
              <div className={`relative rounded-[2rem] ${tone.bg} text-ink border-[3px] border-paper p-7`}>
                <span ref={stampRef} className={`stamp absolute -top-6 right-6 text-2xl bg-paper ${tone.ink}`}>
                  <span className="lc-word">{VERDICT_LABEL[v.kind].toUpperCase()}</span>
                </span>
                <p className="text-sm font-extrabold tracking-wider text-ink/60">VERDICT · {v.kind}</p>
                <p className="display text-4xl mt-2">{tone.word} the hold</p>
                <p className="mt-3 text-lg font-semibold">{v.reason}</p>
                {v.recall && (
                  <div className="mt-5 grid sm:grid-cols-[7rem_1fr] gap-4 rounded-2xl bg-paper border-2 border-ink p-4">
                    {v.recall.images[0] && (
                      // CPSC-hosted recall photo (public domain, U.S. government work)
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={v.recall.images[0]} alt={`CPSC photo for recall ${v.recall.recallNumber}`} className="w-28 h-28 object-contain rounded-lg bg-white" />
                    )}
                    <div className="text-sm">
                      <p className="font-extrabold">CPSC {v.recall.recallNumber} · {v.recall.recallDate}</p>
                      <p className="font-semibold mt-1">{v.recall.title}</p>
                      {v.recall.hazard && <p className="mt-2 text-ink/75 line-clamp-3"><b>Hazard:</b> {v.recall.hazard}</p>}
                      <a href={v.recall.url} target="_blank" rel="noreferrer" className="inline-block mt-2 font-bold underline decoration-2 underline-offset-4">
                        Read the recall notice ↗
                      </a>
                    </div>
                  </div>
                )}
                <p className="mt-4 text-xs font-bold text-ink/50">Index as of {v.asOf} · answered in {res?.ms} ms</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
