"use client";

import { useEffect, useState } from "react";

/**
 * The seller's view of one deal, read live from MongoDB Atlas every 3 seconds: both people at the curb see the
 * same status, and the seller sees WHY a hold was reversed (the recall or the banned type), not just that it was.
 */
type Deal = {
  dealId: string; listing: string; amountUsd: number; status: string; card: string | null; agent: string | null;
  createdAt: string; updatedAt: string; events: { at: string; status: string; note: string }[];
  verdict?: { kind: string; reason: string; recall?: string | null }; passportPath?: string | null;
};
const TONE: Record<string, string> = { HELD: "bg-amber", CAPTURED: "bg-green text-paper", REVERSED: "bg-red text-paper", REFUSED: "bg-sand", UNKNOWN: "bg-sand" };
const WORD: Record<string, string> = { HELD: "Held at Visa", CAPTURED: "Paid to the seller", REVERSED: "Reversed: buyer keeps the money", REFUSED: "Visa refused", UNKNOWN: "Unconfirmed" };

export function DealLive({ dealId }: { dealId: string }) {
  const [d, setD] = useState<Deal | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    const started = Date.now();
    const load = async () => {
      try {
        const r = await fetch(`/api/deals/${dealId}`, { cache: "no-store" });
        const j = await r.json();
        if (!live) return;
        // the record is written just after Visa answers, so a first look can arrive before it: keep polling
        if (r.status === 404) { setErr(Date.now() - started < 20_000 ? "Waiting for this deal's record…" : j.error ?? "No record of this deal."); return; }
        if (!r.ok) { setErr(j.error ?? `HTTP ${r.status}`); return; }
        setErr(""); setD(j);
      } catch { if (live) setErr("Could not reach the deal store; retrying."); }
    };
    void load();
    const t = window.setInterval(load, 3000);
    return () => { live = false; window.clearInterval(t); };
  }, [dealId]);

  if (!d) return <p className="hand text-3xl mt-6">{err || "loading the deal…"}</p>;
  return (
    <div aria-live="polite" className="grid gap-5 mt-6">
      <div className={`rounded-[2rem] border-[3px] border-ink p-6 ${TONE[d.status] ?? "bg-sand"}`}>
        <p className="text-sm font-extrabold tracking-wider">LIVE FROM THE DEAL RECORD · UPDATES EVERY 3 S</p>
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
        Paid by {d.card === "microform" ? "a card entered in Visa Microform" : "Visa's sandbox test card"}
        {d.agent ? `, bought by our agent (Trusted Agent Protocol key ${d.agent})` : ""}. Visa is the record of the
        money; this page mirrors it.
      </p>
    </div>
  );
}
