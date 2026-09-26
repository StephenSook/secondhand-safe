"use client";

import { useEffect, useState, type FormEvent } from "react";

/**
 * "Call me if it's recalled" (PLAN 6.12): an opt-in phone number for ONE deal, proved by that deal's token. When the
 * hold is reversed for a recall or a banned type (or the recall watch later flags the sale), Lullabuy calls once and
 * speaks the result. Shows the call on this buyer's own screen with the last 4 digits only.
 */
type Status = { optedIn: boolean; last4: string | null; calls: { reason: string; status: string; last4: string; at: string }[] };
type DealState = "HELD" | "CAPTURED" | "REVERSED" | "REFUSED" | "UNKNOWN";

const time = (iso: string) => { try { return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); } catch { return ""; } };
const CALL_LINE: Record<string, (c: Status["calls"][number]) => string> = {
  placed: (c) => `Called ...${c.last4} at ${time(c.at)}`,
  answered: (c) => `Called ...${c.last4} at ${time(c.at)} (answered)`,
  completed: (c) => `Called ...${c.last4} at ${time(c.at)} (call finished)`,
  unanswered: (c) => `Called ...${c.last4} at ${time(c.at)}: no answer`,
  failed: (c) => `The call to ...${c.last4} could not be placed`,
  capped: () => "No call: today's call limit was reached",
  claimed: (c) => `Calling ...${c.last4}…`,
  placing: (c) => `Calling ...${c.last4}…`,
};

export function RecallCallOptIn({ token, status }: { token: string; status: DealState }) {
  const [st, setSt] = useState<Status | null>(null);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let alive = true, n = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const r = await fetch("/api/recall-call/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }), cache: "no-store" });
        const j = (await r.json()) as Status;
        if (!alive || !r.ok) return;
        setSt(j);
        // after a reversal, follow the call for about a minute
        const waiting = status === "REVERSED" && j.optedIn && !j.calls.some((c) => !["claimed", "placing"].includes(c.status));
        if (waiting && ++n < 15) timer = setTimeout(load, 4000);
      } catch {}
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [token, status]);

  async function optIn(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/recall-call/optin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, phone }) });
      const j = (await r.json().catch(() => ({}))) as { last4?: string; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSt((s) => ({ optedIn: true, last4: j.last4 ?? null, calls: s?.calls ?? [] }));
      setPhone("");
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!st) return null;
  const call = st.calls[0];
  const canOptIn = !st.optedIn && !call && (status === "HELD" || status === "CAPTURED");
  if (!st.optedIn && !call && !canOptIn) return null;
  return (
    <div className="mt-4 rounded-2xl border-2 border-current p-3">
      <p className="text-sm font-extrabold tracking-wider">RECALL CALL</p>
      {call ? (
        <p role="status" className="mt-1 font-bold">{(CALL_LINE[call.status] ?? CALL_LINE.placed)(call)}</p>
      ) : st.optedIn ? (
        <p role="status" className="mt-1 font-bold">We&apos;ll call ...{st.last4} once if this item is recalled.</p>
      ) : (
        <form onSubmit={optIn} className="mt-2 grid gap-2">
          <label className="text-sm font-bold">Call me if it&apos;s recalled (US numbers)
            <input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(404) 555-0123"
              className="mt-1 w-full rounded-xl border-2 border-ink bg-paper text-ink px-3 py-2 font-mono focus:outline-none focus:ring-4 focus:ring-amber" />
          </label>
          <button type="submit" disabled={busy || phone.replace(/\D/g, "").length < 10} className="justify-self-start rounded-full border-2 border-current px-4 py-2 font-extrabold disabled:opacity-60">
            {busy ? "Saving…" : "Call me if it's recalled"}
          </button>
          <p className="text-xs font-semibold opacity-80">We&apos;ll call this number once if the item is recalled. Standard call, no marketing.</p>
        </form>
      )}
      {msg && <p role="alert" className="mt-2 text-sm font-bold">{msg}</p>}
    </div>
  );
}
