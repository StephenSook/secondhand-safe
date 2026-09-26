"use client";

import { useEffect, type ReactNode } from "react";
import Lenis from "lenis";
import { setupGsap, ScrollTrigger, gsap, prefersReducedMotion } from "./gsap";

/** Lenis smooth scroll driven by GSAP's ticker so ScrollTrigger and Lenis agree on every frame. */
export function SmoothScroll({ children }: { children: ReactNode }) {
  useEffect(() => {
    setupGsap();
    if (prefersReducedMotion()) return;
    const lenis = new Lenis({ lerp: 0.2, wheelMultiplier: 0.9 });
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (t: number) => lenis.raf(t * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    (window as unknown as { __lenis?: Lenis }).__lenis = lenis;
    return () => {
      gsap.ticker.remove(tick);
      lenis.destroy();
    };
  }, []);
  return <>{children}</>;
}
