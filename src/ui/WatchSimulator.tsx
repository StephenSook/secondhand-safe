"use client";

import { useState } from "react";

type Hit = { dealId: string; listing: string; matchedModel: string; batchCheck: string };
type Result = { watchedSales: number; matches: Hit[]; notified: { sent: number; failed: number }; hypothetical: { model: string; batches: string[] } };

/** The labelled simulation: a hypothetical recall re-checked against every real captured sale (nothing is saved). */
export function WatchSimulator({ suggestions }: { suggestions: string[] }) {
  const [model, setModel] = useState("");
  const [batch, setBatch] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState("");
  async function run(m = model) {
    setBusy(true); setErr(""); setRes(null);
    try {
      const r = await fetch("/api/watch/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: m, batch }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setRes(j);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-[2rem] border-[3px] border-ink bg-paper p-6">
      <p className="text-sm font-extrabold tracking-wider">SIMULATION · NOT A REAL RECALL</p>
      <h2 className="display text-3xl mt-1">What if CPSC recalled this model tomorrow?</h2>
      <form className="mt-4 grid sm:grid-cols-[1fr_1fr_auto] gap-3" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <label className="font-bold text-sm">Model number
          <input value={model} onChange={(e) => setModel(e.target.value)} required minLength={4} maxLength={40}
            className="mt-1 w-full rounded-xl border-2 border-ink px-3 py-2 font-mono uppercase" />
        </label>
        <label className="font-bold text-sm">Recalled batches (optional, comma separated)
          <input value={batch} onChange={(e) => setBatch(e.target.value)} maxLength={200}
            className="mt-1 w-full rounded-xl border-2 border-ink px-3 py-2 font-mono uppercase" />
        </label>
        <button type="submit" disabled={busy || model.trim().length < 4} className="self-end h-11 rounded-full border-[3px] border-ink bg-amber px-5 font-extrabold disabled:opacity-50">
          {busy ? "Re-checking…" : "Re-check every sale"}
        </button>
      </form>
      {suggestions.length > 0 && (
        <p className="mt-3 text-sm font-semibold">Models from real sales on our demo table:{" "}
          {suggestions.map((s) => <button key={s} type="button" onClick={() => { setModel(s); void run(s); }} className="mr-2 underline font-mono">{s}</button>)}
        </p>
      )}
      {err && <p role="alert" className="mt-3 font-bold text-red-deep">{err}</p>}
      {res && (
        <div role="status" className="mt-4 rounded-2xl bg-sand p-4 font-semibold">
          <p>Re-checked {res.watchedSales} real captured sales for model <b className="font-mono">{res.hypothetical.model}</b>: {res.matches.length === 0 ? "none would be affected." : `${res.matches.length} would be affected.`}</p>
          <ul className="mt-2 grid gap-1">
            {res.matches.map((h) => <li key={h.dealId}>Sale <a className="underline" href={`/deal/${h.dealId}`}>{h.dealId}</a> ({h.listing}): model {h.matchedModel}, batch {h.batchCheck}</li>)}
          </ul>
          <p className="mt-2 text-sm">Notifications sent to watching browsers: {res.notified.sent}. They are titled &quot;Simulated recall (demo)&quot;. Nothing was written to any sale.</p>
        </div>
      )}
    </div>
  );
}
