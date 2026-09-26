"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-renders the server page every few seconds, a bounded number of times (a just-sent transaction takes a moment to be readable). */
export function AutoRefresh({ everyMs = 3000, times = 15 }: { everyMs?: number; times?: number }) {
  const router = useRouter();
  useEffect(() => {
    let n = 0;
    const t = window.setInterval(() => { n += 1; if (n > times) window.clearInterval(t); else router.refresh(); }, everyMs);
    return () => window.clearInterval(t);
  }, [router, everyMs, times]);
  return null;
}
