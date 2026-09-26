"use client";

import { useEffect, useRef, useState } from "react";
import { setupGsap, gsap, prefersReducedMotion } from "./motion/gsap";
import { Mark } from "./Mark";

const introDone = () => window.dispatchEvent(new Event("shs:intro-done"));

/**
 * Intro: the page starts HELD (amber). Our mark pops in, a scan line sweeps across it, then the amber field
 * retracts along one fat stroked path and uncovers the page. The ribbon's last sliver flashes green:
 * captured. Plays once per browser session (add ?intro to force it); skipped under reduced motion.
 *
 * Started from a ref guard, not useGSAP: React StrictMode mounts twice in development and a context revert
 * would freeze the overlay half-drawn. A timeout always removes the overlay even if an animation fails.
 */
export function Preloader() {
  const root = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const finish = () => {
      document.documentElement.style.overflow = "";
      try { sessionStorage.setItem("shs-intro", "1"); } catch {}
      setDone(true);
      introDone();
    };
    const forced = new URLSearchParams(window.location.search).has("intro");
    let seen = false;
    try { seen = sessionStorage.getItem("shs-intro") === "1"; } catch {}
    if (prefersReducedMotion() || (seen && !forced) || !root.current) {
      setDone(true);
      introDone();
      return;
    }
    setupGsap();
    document.documentElement.style.overflow = "hidden";
    const q = gsap.utils.selector(root);
    const safety = window.setTimeout(finish, 4500);
    const tl = gsap.timeline({ onComplete: () => { window.clearTimeout(safety); finish(); } });
    tl.set(q(".pl-path"), { drawSVG: "0% 100%" })
      .fromTo(q(".pl-mark"), { scale: 0, rotate: -64, autoAlpha: 0 },
        { scale: 1, rotate: 0, autoAlpha: 1, duration: 0.65, ease: "elastic.out(1,0.72)" }, 0.1)
      .fromTo(q(".pl-scan"), { yPercent: -900, autoAlpha: 1 },
        { yPercent: 900, duration: 0.55, ease: "power2.inOut" }, 0.55)
      .fromTo(q(".pl-word"), { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: "energy" }, 0.6)
      .to(q(".pl-mark, .pl-word"), { scale: 0, rotate: 64, autoAlpha: 0, duration: 0.5, ease: "elastic.in(1,0.72)" }, 1.15)
      .to(q(".pl-path"), {
        keyframes: { "92%": { strokeWidth: "7%", ease: "circ.out" }, "100%": { drawSVG: "100% 100%" } },
        duration: 1.2,
      }, 1.2)
      .to(q(".pl-path"), { stroke: "#1fa35b", duration: 0.12 }, 2.1)
      .add(introDone, 1.6);
  }, []);

  if (done) return null;
  return (
    <div ref={root} className="fixed inset-0 z-[100] pointer-events-none" aria-hidden="true">
      <svg viewBox="0 0 1080 1080" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
        <path
          className="pl-path"
          d="M-160 140 C 240 -120, 520 420, 300 640 S 620 1180, 900 820 S 1260 380, 1240 1240"
          fill="none"
          stroke="#ffb020"
          strokeWidth="75%"
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="relative flex flex-col items-center gap-4">
          <div className="pl-mark relative overflow-hidden rounded-3xl invisible">
            <Mark size={132} />
            <div className="pl-scan absolute inset-x-0 top-1/2 h-1.5 bg-red shadow-[0_0_24px_6px_rgba(229,72,77,0.6)]" />
          </div>
          <p className="pl-word hand text-4xl text-ink invisible">held, not paid</p>
        </div>
      </div>
    </div>
  );
}
