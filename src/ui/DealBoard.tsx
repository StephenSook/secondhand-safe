"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/** The deal board for the expo screen: every hold and how it ended, read from MongoDB Atlas every 3 seconds. */
type Row = { dealId: string; listing: string; amountUsd: number; status: string; updatedAt: string; verdict?: { kind: string } };
type Board = { recent: Row[]; byStatus: Record<string, { n: number; usd: number }> };
const CHIP: Record<string, string> = { HELD: "bg-amber", CAPTURED: "bg-green text-paper", REVERSED: "bg-red text-paper", REFUSED: "bg-sand", UNKNOWN: "bg-sand", RELEASED: "bg-aqua", LAPSED: "bg-sand" };

export function DealBoard() {
  const [b, setB] = useState<Board | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch("/api/deals", { cache: "no-store" });
        const j = await r.json();
        if (!live) return;
        if (!r.ok) { setErr(j.error ?? `HTTP ${r.status}`); return; }
        setErr(""); setB(j);
      } catch { if (live) setErr("Could not reach the deal store; retrying."); }
    };
    void load();
    const t = window.setInterval(load, 3000);
    return () => { live = false; window.clearInterval(t); };
  }, []);
  if (!b) return <p className="hand text-3xl mt-6">{err || "loading the board…"}</p>;
  const s = (k: string) => b.byStatus[k] ?? { n: 0, usd: 0 };
  return (
    <div className="grid gap-6 mt-6">
      <div className="grid sm:grid-cols-3 gap-4">
        {[["HELD", "held right now"], ["REVERSED", "reversed: money kept from a recalled or banned item"], ["CAPTURED", "paid to sellers after a clean label"]].map(([k, label]) => (
          <div key={k} className={`rounded-[2rem] border-[3px] border-ink p-5 ${CHIP[k]}`}>
            <p className="display text-5xl">${s(k).usd.toFixed(2)}</p>
            <p className="font-bold">{s(k).n} deals {label}</p>
          </div>
        ))}
      </div>
      <ul className="rounded-[2rem] border-[3px] border-ink bg-paper divide-y-2 divide-ink/10">
        {b.recent.length === 0 && <li className="p-5 font-semibold">No deals yet. Start one on the shop or pickup page.</li>}
        {b.recent.map((r) => (
          <li key={r.dealId} className="p-4 grid grid-cols-[auto_1fr_auto] gap-3 items-center">
            <span className={`rounded-full border-2 border-ink px-3 py-0.5 text-xs font-extrabold ${CHIP[r.status] ?? "bg-sand"}`}>{r.status}</span>
            <Link href={`/deal/${r.dealId}`} className="font-bold truncate underline-offset-4 hover:underline">{r.listing}</Link>
            <span className="display text-xl">${r.amountUsd.toFixed(2)}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs font-semibold text-ink/60">Visa sandbox transactions, recorded in MongoDB Atlas as they happen. Visa is the record of the money; this board mirrors it.</p>
    </div>
  );
}
