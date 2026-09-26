"use client";

import { useState } from "react";

type Result = { watchedSales: number; affected: number; hypothetical: { model: string; batches: string[] };
  yourSale: { affected: boolean; batchCheck: string | null; notified: number } | null };

/** The sale this browser just completed on /pickup, if any: its deal token lets only YOUR sale be notified. */
function myToken(): string | undefined {
  try {
    const d = JSON.parse(sessionStorage.getItem("shs-deal") ?? "null") as { status?: string; token?: string } | null;
    return d?.status === "CAPTURED" && typeof d.token === "string" ? d.token : undefined;
  } catch {
    return undefined;
  }
}

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
      const r = await fetch("/api/watch/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: m, batch, token: myToken() }) });
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
      <p className="mt-3 text-sm font-semibold">Try the clean label on our demo table:{" "}
        {suggestions.map((s) => <button key={s} type="button" onClick={() => { setModel(s); void run(s); }} className="mr-2 underline font-mono">{s}</button>)}
      </p>
      {err && <p role="alert" className="mt-3 font-bold text-red-deep">{err}</p>}
      {res && (
        <div role="status" className="mt-4 rounded-2xl bg-sand p-4 font-semibold">
          <p>Re-checked {res.watchedSales} real captured sales for model <b className="font-mono">{res.hypothetical.model}</b>: {res.affected === 0 ? "none would be affected." : `${res.affected} would be affected.`}</p>
          {res.yourSale && (
            <p className="mt-2">Your sale: {res.yourSale.affected ? `affected (batch ${res.yourSale.batchCheck}). ${res.yourSale.notified ? "Your browser was just notified." : "Turn on the recall watch on /pickup to get the notification."}` : "not affected."}</p>
          )}
          <p className="mt-2 text-sm">Only your own sale can be notified, titled &quot;Simulated recall (demo)&quot;. No sale is named here and nothing was written.</p>
        </div>
      )}
    </div>
  );
}
