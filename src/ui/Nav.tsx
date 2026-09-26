"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Mark } from "./Mark";

const LINKS = [
  { href: "/#how", label: "How it works" },
  { href: "/#check", label: "Live check" },
  { href: "/#oracle", label: "The model" },
  { href: "/map", label: "Atlanta scan" },
  { href: "/pickup", label: "Pickup scan" },
  { href: "/judge", label: "Judges" },
];

/** Pill nav. The status dot next to the name shows HELD amber, the state everything starts in. */
export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 50);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <header className="fixed top-3 inset-x-3 z-50 flex items-center justify-between gap-3 pointer-events-none">
      <Link href="/" className="pointer-events-auto flex items-center gap-2 rounded-full bg-paper/90 backdrop-blur px-3 py-2 shadow-[0_2px_0_var(--ink)] border-2 border-ink">
        <Mark size={28} />
        <span className={`display text-lg transition-[max-width,opacity] duration-500 overflow-hidden whitespace-nowrap ${scrolled ? "max-w-0 opacity-0 sm:max-w-[12em] sm:opacity-100" : "max-w-[12em]"}`}>
          SecondHand Safe
        </span>
      </Link>
      <nav aria-label="Main" className="pointer-events-auto hidden md:flex items-center gap-1.5">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href}
            className="rounded-full bg-amber-soft border-2 border-ink px-4 py-2 font-bold text-sm hover:bg-amber transition-colors shadow-[0_2px_0_var(--ink)] hover:-translate-y-0.5 transition-transform">
            {l.label}
          </Link>
        ))}
      </nav>
      <Link href="/judge" className="pointer-events-auto md:hidden rounded-full bg-ink text-paper px-4 py-2.5 font-bold text-sm">
        Judges start here
      </Link>
    </header>
  );
}
