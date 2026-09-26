"use client";

import { useRef } from "react";
import { setupGsap, useGSAP, gsap, prefersReducedMotion } from "./motion/gsap";

const STEPS = [
  { n: "1", art: "/art/spot-handshake.webp", title: "Agree and hold", body: "You agree on a price. Visa authorizes the card and holds the money. The seller sees it is real; you have not paid.", chip: "HELD", cls: "bg-amber", chipCls: "bg-ink text-amber", note: "held, not paid" },
  { n: "2", art: "/art/spot-parent-scan.webp", title: "Meet and scan", body: "At pickup, point your phone at the label on the back or underside. The barcode scanner reads the UPC.", chip: "SCANNING", cls: "bg-aqua", chipCls: "bg-ink text-aqua", note: "we read the label, not the listing" },
  { n: "3", title: "Check it for real", body: "Model and batch go against every CPSC nursery recall; the photo goes through our trained banned-type model.", chip: "CHECKING", cls: "bg-sand", chipCls: "bg-ink text-sand", note: "no inclined sleepers, ever" },
  { n: "4", title: "Capture or reverse", body: "No match: the hold is captured and the seller is paid. Recalled or banned: the hold is reversed. No dispute.", chip: "CAPTURED / REVERSED", cls: "bg-green-soft", chipCls: "bg-ink text-green-soft", note: "and nobody took it home" },
];

/**
 * Four fanned step cards (reference technique: fanned deck with hover focus). They fly up on scroll with an
 * elastic, sit at random tilts, and straighten when you point at one, like picking a card up to read it.
 */
export function HowItWorks() {
  const root = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      setupGsap();
      const q = gsap.utils.selector(root);
      const cards = q(".hw-card") as HTMLElement[];
      const tilt = () => cards.forEach((c) => gsap.to(c, {
        rotation: gsap.utils.random(-7.5, 7.5), xPercent: gsap.utils.random(-4, 4), yPercent: gsap.utils.random(-4, 4),
        scale: 1, duration: 0.85, ease: "elastic.out(1,0.75)" }));
      if (prefersReducedMotion()) return;
      tilt();
      gsap.from(cards, { yPercent: 150, duration: 1.05, ease: "elastic.out(1,0.75)", stagger: 0.088,
        scrollTrigger: { trigger: root.current, start: "top 75%", once: true } });
      const grid = q(".hw-grid")[0] as HTMLElement;
      if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
      let active = -1;
      const move = (e: PointerEvent) => {
        const r = grid.getBoundingClientRect();
        const i = Math.min(cards.length - 1, Math.floor(((e.clientX - r.left) / r.width) * cards.length));
        if (i === active) return;
        active = i;
        cards.forEach((c, j) => gsap.to(c, j === i
          ? { rotation: 0, xPercent: 0, yPercent: -4, scale: 1.075, zIndex: 5, duration: 0.85, ease: "elastic.out(1,0.75)" }
          : { scale: 0.97, zIndex: 1, xPercent: 12 / (j - i), duration: 0.85, ease: "elastic.out(1,0.75)" }));
      };
      grid.addEventListener("pointermove", move);
      grid.addEventListener("pointerleave", () => { active = -1; tilt(); });
    },
    { scope: root },
  );

  return (
    <section ref={root} id="how" className="relative px-3 mt-3 scroll-mt-20" aria-labelledby="how-title">
      <div className="section-card bg-aqua-soft px-6 sm:px-12 py-24">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <h2 id="how-title" className="display text-[clamp(2.6rem,5.4vw,5.4rem)]">How it works</h2>
          <p className="hand text-3xl text-teal rotate-2 max-w-[14em]">Visa&apos;s own auth-then-capture, the way hotels and gas pumps use it</p>
        </div>
        <ol className="hw-grid mt-14 grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {STEPS.map((s) => (
            <li key={s.n} className={`hw-card relative rounded-[2rem] border-[3px] border-ink p-6 pt-5 min-h-[21rem] shadow-[6px_8px_0_var(--ink)] ${s.cls}`}>
              <p className="hand text-3xl">Step #{s.n}</p>
              {"art" in s && s.art && (
                // Generated ink spot illustration (public/art/CREDITS.md)
                // eslint-disable-next-line @next/next/no-img-element
                <img src={s.art} alt="" className="absolute right-4 top-4 w-24 h-24 object-cover rounded-2xl border-2 border-ink rotate-3" />
              )}
              <span className={`inline-block mt-4 rounded-full px-3 py-1 text-xs font-extrabold tracking-wider ${s.chipCls}`}>{s.chip}</span>
              <h3 className="display text-3xl mt-4">{s.title}</h3>
              <p className="mt-3 font-semibold leading-snug">{s.body}</p>
              <p className="hand text-xl mt-5 text-ink/70 -rotate-2">{s.note}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
