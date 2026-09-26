"use client";

import { useRef } from "react";
import { setupGsap, useGSAP, gsap, ScrollTrigger, prefersReducedMotion } from "./motion/gsap";

/**
 * Layered seaside waves in three tints of one hue. They "breathe": a stroke the same color as the fill grows
 * and shrinks, so each layer swells. Plays only while on screen.
 */
export function WaveBlobs({ tints, className = "" }: { tints: [string, string, string]; className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useGSAP(
    () => {
      setupGsap();
      if (prefersReducedMotion() || !ref.current) return;
      const paths = ref.current.querySelectorAll("path");
      const tl = gsap.timeline({ repeat: -1, yoyo: true, paused: true });
      tl.to(paths, { attr: { "stroke-width": 46 }, rotate: 1.5, transformOrigin: "50% 50%", duration: 3, ease: "sine.inOut", stagger: 0.4 });
      ScrollTrigger.create({ trigger: ref.current, start: "top bottom", end: "bottom top",
        onToggle: (s) => (s.isActive ? tl.play() : tl.pause()) });
    },
    { scope: ref },
  );
  return (
    <svg ref={ref} viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" className={`absolute inset-0 w-full h-full ${className}`} aria-hidden="true">
      <path d="M0 520C160 420 300 610 470 540S760 320 930 420s330 250 510 150V900H0z" fill={tints[0]} stroke={tints[0]} strokeWidth="0" strokeLinejoin="round" />
      <path d="M0 650c200-90 330 60 520 10s330-220 520-110 280 150 400 80V900H0z" fill={tints[1]} stroke={tints[1]} strokeWidth="0" strokeLinejoin="round" />
      <path d="M0 790c170-60 310 40 490 0s340-150 540-60 260 80 410 30V900H0z" fill={tints[2]} stroke={tints[2]} strokeWidth="0" strokeLinejoin="round" />
    </svg>
  );
}
