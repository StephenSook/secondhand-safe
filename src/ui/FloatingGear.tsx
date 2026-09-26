"use client";

import { useRef } from "react";
import { setupGsap, useGSAP, gsap, prefersReducedMotion } from "./motion/gsap";

/** Glossy used baby gear floating around the hero deal card, drifting with the pointer (depth parallax). */
const GEAR = [
  { src: "/art/obj-carseat.webp", alt: "", cls: "w-[11rem] -left-40 -top-24", depth: 1.2, rot: -14 },
  { src: "/art/obj-highchair.webp", alt: "", cls: "w-[9rem] -right-28 -top-20", depth: 0.8, rot: 12 },
  { src: "/art/obj-crib.webp", alt: "", cls: "w-[12rem] -right-36 bottom-[-6rem]", depth: 1.5, rot: 8 },
  { src: "/art/obj-bassinet.webp", alt: "", cls: "w-[9.5rem] -left-32 bottom-[-4rem]", depth: 0.6, rot: -8 },
];

export function FloatingGear() {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      setupGsap();
      const items = gsap.utils.toArray<HTMLElement>(".fg-item", root.current);
      if (prefersReducedMotion()) return;
      items.forEach((el, i) => {
        gsap.from(el, { scale: 0, rotate: -40, opacity: 0, duration: 1.1, ease: "elastic.out(1,0.6)", delay: 1.2 + i * 0.12 });
        gsap.to(el, { y: "+=14", rotate: `+=${i % 2 ? 4 : -4}`, duration: 2.6 + i * 0.4, ease: "sine.inOut", yoyo: true, repeat: -1 });
      });
      if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
      const onMove = (e: PointerEvent) => {
        const nx = e.clientX / window.innerWidth - 0.5, ny = e.clientY / window.innerHeight - 0.5;
        items.forEach((el) => gsap.to(el, { x: nx * 40 * Number(el.dataset.depth), y: ny * 30 * Number(el.dataset.depth), duration: 1.2, ease: "power3.out", overwrite: "auto" }));
      };
      window.addEventListener("pointermove", onMove);
      return () => window.removeEventListener("pointermove", onMove);
    },
    { scope: root },
  );
  return (
    <div ref={root} className="pointer-events-none absolute inset-0 hidden md:block" aria-hidden="true">
      {GEAR.map((g) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={g.src} src={g.src} alt={g.alt} data-depth={g.depth}
          className={`fg-item absolute ${g.cls} drop-shadow-[0_18px_22px_rgba(20,22,58,0.35)]`} style={{ rotate: `${g.rot}deg` }} />
      ))}
    </div>
  );
}
