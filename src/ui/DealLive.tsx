"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LIVE_LABEL, useLiveRefresh } from "./useLiveRefresh";

/**
 * The seller's view of one deal, re-read from MongoDB Atlas when its change stream reports a change to this deal
 * (every 3 seconds when the stream is not available): both people at the curb see the
 * same status, and the seller sees WHY a hold was reversed (the recall or the banned type), not just that it was.
 */
type Deal = {
  dealId: string; listing: string; amountUsd: number; status: string; card: string | null; agent: string | null;
  createdAt: string; updatedAt: string; events: { at: string; status: string; note: string }[];
  verdict?: { kind: string; reason: string; recall?: string | null }; passportPath?: string | null;
};
const TONE: Record<string, string> = { HELD: "bg-amber", CAPTURED: "bg-green text-paper", REVERSED: "bg-red text-paper", REFUSED: "bg-sand", UNKNOWN: "bg-sand", RELEASED: "bg-aqua", LAPSED: "bg-sand" };
const WORD: Record<string, string> = { HELD: "Held at Visa", CAPTURED: "Paid to the seller", REVERSED: "Reversed: buyer keeps the money", REFUSED: "Visa refused", UNKNOWN: "Unconfirmed", RELEASED: "Released: pickup never happened", LAPSED: "Lapsed: never captured" };

export function DealLive({ dealId }: { dealId: string }) {
  const [d, setD] = useState<Deal | null>(null);
  const [err, setErr] = useState("");
  const alive = useRef(true);
  const seq = useRef(0);
  const started = useRef(0);
  useEffect(() => { alive.current = true; started.current = Date.now(); return () => { alive.current = false; }; }, [dealId]);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const r = await fetch(`/api/deals/${dealId}`, { cache: "no-store" });
      const j = await r.json();
      if (!alive.current || n !== seq.current) return; // a newer read has started: never show an older answer over it
      // the record is written just after Visa answers, so a first look can arrive before it: keep polling
      if (r.status === 404) { setErr(Date.now() - started.current < 20_000 ? "Waiting for this deal's record…" : j.error ?? "No record of this deal."); return; }
      if (!r.ok) { setErr(j.error ?? `HTTP ${r.status}`); return; }
      setErr(""); setD(j);
    } catch { if (alive.current && n === seq.current) setErr("Could not reach the deal store; retrying."); }
  }, [dealId]);
  const mode = useLiveRefresh(`/api/stream?deal=${encodeURIComponent(dealId)}`, load);

  if (!d) return <p className="hand text-3xl mt-6">{err || "loading the deal…"}</p>;
  return (
    <div aria-live="polite" className="grid gap-5 mt-6">
      <div className={`rounded-[2rem] border-[3px] border-ink p-6 ${TONE[d.status] ?? "bg-sand"}`}>
        <p className="text-sm font-extrabold tracking-wider">FROM THE DEAL RECORD · <span data-testid="live-mode">{LIVE_LABEL[mode].toUpperCase()}</span></p>
        <p className="display text-5xl mt-1">{WORD[d.status] ?? d.status}</p>
        <p className="display text-2xl mt-1">${d.amountUsd.toFixed(2)}</p>
        <p className="font-semibold opacity-85">{d.listing}</p>
        {d.verdict && <p className="mt-3 font-bold">{d.verdict.reason}</p>}
        {d.passportPath && <a href={d.passportPath} className="mt-2 inline-block underline font-bold">Item passport</a>}
      </div>
      <ol className="rounded-[2rem] border-[3px] border-ink bg-paper p-6 grid gap-2">
        {d.events.map((e, i) => (
          <li key={i} className="grid grid-cols-[6.5rem_1fr] gap-3 text-sm">
            <span className="font-mono opacity-70">{new Date(e.at).toLocaleTimeString()}</span>
            <span><b>{e.status}</b> · {e.note}</span>
          </li>
        ))}
      </ol>
      <p className="text-xs font-semibold text-ink/60">
        Paid by {d.card === "microform" ? "a card entered in Visa Microform" : d.card === "saved-card" ? "a saved card (Visa Token Management Service)" : "Visa's sandbox test card"}
        {d.agent ? `, bought by our agent (Trusted Agent Protocol key ${d.agent})` : ""}. Visa is the record of the
        money; this page mirrors it.
      </p>
    </div>
  );
}
