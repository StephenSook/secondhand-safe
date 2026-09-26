"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LIVE_LABEL, useLiveRefresh } from "./useLiveRefresh";

/** The deal board for the expo screen: every hold and how it ended, re-read from MongoDB Atlas when its change
 *  stream reports a deal change, or every 3 seconds when the stream is not available. */
type Row = { dealId: string; listing: string; amountUsd: number; status: string; updatedAt: string; verdict?: { kind: string } };
type Board = { recent: Row[]; byStatus: Record<string, { n: number; usd: number }> };
const CHIP: Record<string, string> = { HELD: "bg-amber", CAPTURED: "bg-green text-paper", REVERSED: "bg-red text-paper", REFUSED: "bg-sand", UNKNOWN: "bg-sand", RELEASED: "bg-aqua", LAPSED: "bg-sand" };

export function DealBoard() {
  const [b, setB] = useState<Board | null>(null);
  const [err, setErr] = useState("");
  const alive = useRef(true);
  const seq = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const r = await fetch("/api/deals", { cache: "no-store" });
      const j = await r.json();
      if (!alive.current || n !== seq.current) return; // a newer read has started: never show an older answer over it
      if (!r.ok) { setErr(j.error ?? `HTTP ${r.status}`); return; }
      setErr(""); setB(j);
    } catch { if (alive.current && n === seq.current) setErr("Could not reach the deal store; retrying."); }
  }, []);
  const mode = useLiveRefresh("/api/stream", load);
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
      <p className="text-xs font-semibold text-ink/60"><span data-testid="live-mode" className="font-extrabold">{LIVE_LABEL[mode]}</span> · Visa sandbox transactions, recorded in MongoDB Atlas as they happen. Visa is the record of the money; this board mirrors it.</p>
    </div>
  );
}
