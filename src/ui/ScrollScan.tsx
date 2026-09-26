"use client";

import { useEffect, useRef } from "react";
import { setupGsap, gsap, ScrollTrigger, prefersReducedMotion } from "./motion/gsap";

const FRAMES = 96;
const src = (i: number) => `/art/seq/frame-${String(i + 1).padStart(3, "0")}.webp`;

/**
 * Pinned, scroll-scrubbed image sequence (reference technique: canvas frame scrub with text cues).
 * Frames load first/last/midpoints first so any scroll position has a near frame to show.
 */
export function ScrollScan() {
  const wrap = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    setupGsap();
    const c = canvas.current!;
    const ctx = c.getContext("2d")!;
    const frames: (ImageBitmap | null)[] = Array(FRAMES).fill(null);
    let current = 0;
    let alive = true;

    const draw = (i: number) => {
      let k = i;
      for (let d = 0; d < FRAMES && !frames[k]; d++) k = frames[i - d] ? i - d : Math.min(FRAMES - 1, i + d);
      const img = frames[k];
      if (!img) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = c.clientWidth * dpr, h = c.clientHeight * dpr;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const s = Math.max(w / img.width, h / img.height);
      ctx.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
    };

    const order: number[] = [];
    const seen = new Set<number>();
    const push = (i: number) => { if (!seen.has(i)) { seen.add(i); order.push(i); } };
    push(0); push(FRAMES - 1);
    for (let step = FRAMES >> 1; step >= 1; step >>= 1) for (let i = 0; i < FRAMES; i += step) push(i);
    (async () => {
      for (const i of order) {
        if (!alive) return;
        try {
          const b = await (await fetch(src(i))).blob();
          frames[i] = await createImageBitmap(b);
          if (Math.abs(i - current) < 3 || i === 0) draw(current);
        } catch {}
      }
    })();

    if (prefersReducedMotion()) {
      current = 60;
      return () => { alive = false; };
    }
    const q = gsap.utils.selector(wrap);
    const cues = gsap.timeline({ paused: true })
      .to(q(".ss-held"), { autoAlpha: 1, y: 0, duration: 0.2 }, 0)
      .to(q(".ss-held"), { autoAlpha: 0, y: -20, duration: 0.15 }, 0.28)
      .to(q(".ss-read"), { autoAlpha: 1, y: 0, duration: 0.2 }, 0.32)
      .to(q(".ss-read"), { autoAlpha: 0, y: -20, duration: 0.15 }, 0.6)
      .fromTo(q(".ss-verdict"), { autoAlpha: 0, scale: 0.4, rotate: -20 }, { autoAlpha: 1, scale: 1, rotate: -6, duration: 0.2, ease: "back.out(2.5)" }, 0.8)
      .to({}, { duration: 0.01 }, 1);
    const st = ScrollTrigger.create({
      trigger: wrap.current, start: "top top", end: "+=220%", pin: true, scrub: true,
      onUpdate: (self) => {
        current = Math.round(self.progress * (FRAMES - 1));
        draw(current);
        cues.progress(self.progress);
      },
    });
    const onResize = () => draw(current);
    window.addEventListener("resize", onResize);
    return () => { alive = false; st.kill(); cues.kill(); window.removeEventListener("resize", onResize); };
  }, []);

  return (
    <section ref={wrap} className="relative px-3 mt-3" aria-label="What happens at pickup">
      <div className="section-card h-[100svh] bg-ink">
        <canvas ref={canvas} className="absolute inset-0 w-full h-full" aria-hidden="true" />
        <div className="absolute inset-0 bg-gradient-to-t from-ink/70 via-transparent to-ink/40" />
        <div className="absolute left-6 sm:left-12 bottom-10 sm:bottom-14 max-w-[30rem] text-paper">
          <p className="ss-held invisible translate-y-5 rounded-2xl bg-amber text-ink p-5 border-[3px] border-ink">
            <span className="block text-xs font-extrabold tracking-widest">PAYMENT</span>
            <span className="display text-4xl">HELD</span>
            <span className="block font-semibold mt-1">You agreed on a price. The money is authorized, not sent.</span>
          </p>
          <p className="ss-read invisible translate-y-5 absolute bottom-0 hand text-5xl text-paper [text-shadow:0_2px_12px_rgba(0,0,0,0.6)]">
            reading the label, not the listing…
          </p>
        </div>
        <span className="ss-verdict invisible stamp absolute right-6 sm:right-16 top-24 sm:top-28 text-[clamp(1.6rem,4vw,3.4rem)] text-green bg-paper">
          CAPTURED
        </span>
        <p className="absolute right-4 bottom-3 text-[0.7rem] font-semibold text-paper/50">Illustration (generated). The real scan runs on /pickup.</p>
      </div>
    </section>
  );
}
