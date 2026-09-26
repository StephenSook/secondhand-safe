"use client";

import Link from "next/link";
import { useRef, type CSSProperties, type ReactNode } from "react";
import { setupGsap, gsap, SplitText, prefersReducedMotion } from "./motion/gsap";

type Props = {
  href?: string;
  onClick?: () => void;
  children: ReactNode;
  icon?: ReactNode;
  bg?: string;
  fg?: string;
  accent?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
};

/** Primary button: the pill squashes and bounces (CSS), and each letter squashes and springs back (GSAP). */
export function SquashButton({ href, onClick, children, icon = "→", bg, fg, accent, type = "button", disabled, className = "" }: Props) {
  const label = useRef<HTMLSpanElement>(null);
  const split = useRef<SplitText | null>(null);
  const style = { "--btn-bg": bg, "--btn-fg": fg, "--btn-accent": accent } as CSSProperties;

  const bounce = () => {
    if (prefersReducedMotion() || !label.current) return;
    setupGsap();
    split.current ??= new SplitText(label.current, { type: "chars" });
    gsap.fromTo(split.current.chars,
      { yPercent: 0, scaleY: 1, rotate: 0 },
      { keyframes: { "20%": { yPercent: 55, scaleY: 0.3, rotate: 17, ease: "power2.in" },
          "100%": { yPercent: 0, scaleY: 1, rotate: 0, ease: "elastic.out(1,0.4)" } },
        duration: 0.725, stagger: { amount: 0.225 }, overwrite: true });
  };

  const inner = (
    <>
      <span className="btn-label"><span ref={label} className="inline-block">{children}</span></span>
      <span className="btn-icon" aria-hidden="true">{icon}</span>
    </>
  );
  if (href) {
    return (
      <Link href={href} className={`btn ${className}`} style={style} onMouseEnter={bounce} onFocus={bounce}>
        {inner}
      </Link>
    );
  }
  return (
    <button type={type} disabled={disabled} className={`btn disabled:opacity-50 ${className}`} style={style} onMouseEnter={bounce} onFocus={bounce} onClick={onClick}>
      {inner}
    </button>
  );
}
