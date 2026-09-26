"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { DEAL_KEY, stale } from "./holdGuard";
import { LIVE_LABEL, useLiveRefresh } from "./useLiveRefresh";
import { WedgeBuffer } from "@/core/wedge";
import { canSettle, kioskState, mergeRecord, readDealToken, type DealStatus, type KioskState } from "@/core/kiosk";
import type { Verdict, VerdictKind } from "@/core/verdict";
import { VERDICT_LABEL } from "@/core/verdict";
import { BRAND } from "@/core/brand";

/**
 * The table kiosk at the expo pickup: one deal, one huge state, and a barcode scanner (or a keyboard) as input.
 * It settles through the same POST /api/pickup with the same deal token /pickup holds, and handles the answer the
 * way /pickup does: a lost or unclear answer is UNKNOWN (never re-posted), a refusal is REFUSED, and only a
 * NO_MATCH captures. The deal record (MongoDB change stream) shows a settlement made from another device.
 */

type Local = {
  token: string; dealId: string; amountUsd: number; listing?: string; status: DealStatus;
  settlementId?: string; reason?: string; passportPath?: string; passportError?: string;
  source: "tab" | "pasted"; unconfirmed?: boolean;
};
type DealRecord = { status: DealStatus; listing: string; amountUsd: number; verdict?: { kind: VerdictKind; reason: string; recall?: string | null }; passportPath?: string | null };
type Stored = { dealId?: string; token?: string; listing?: string; amountUsd?: number; status?: DealStatus; at?: string };

const DO_NOT_RETRY = " The hold may or may not have settled: do not retry, check the Visa Business Center.";

function readStored(): Stored | null {
  try { return JSON.parse(sessionStorage.getItem(DEAL_KEY) || "null") as Stored | null; } catch { return null; }
}

/** Keeps /pickup's copy of the SAME deal in step (so neither page re-posts a settled token); never touches another deal. */
function writeBack(d: Local) {
  try {
    const s = readStored();
    if (!s || s.token !== d.token) return;
    sessionStorage.setItem(DEAL_KEY, JSON.stringify({ ...s, status: d.status, settlementId: d.settlementId, reason: d.reason,
      passportPath: d.passportPath, passportError: d.passportError }));
  } catch {}
}

const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 48 48" aria-hidden="true" className="w-[clamp(4rem,11vw,9rem)] h-[clamp(4rem,11vw,9rem)] shrink-0" fill="none" stroke="currentColor" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="24" cy="24" r="20" />
    {children}
  </svg>
);

const UI: Record<KioskState, { word: string; line: string; tone: string; icon: ReactNode }> = {
  IDLE: { word: "NO DEAL", line: "Attach the buyer's deal to start.", tone: "bg-paper text-ink", icon: <Icon><path d="M17 24h14" /></Icon> },
  HELD: { word: "HELD", line: "The money is held at Visa. Scan the item's barcode.", tone: "bg-amber text-ink", icon: <Icon><path d="M24 13v11l7 5" /></Icon> },
  NEEDS_CHECK: { word: "NEEDS CHECK", line: "Hold kept. No money moved. A person checks the label.", tone: "bg-aqua text-ink", icon: <Icon><path d="M19 19a5 5 0 1 1 7 4.6c-1.3.6-2 1.6-2 3v1" /><path d="M24 34v.5" /></Icon> },
  CAPTURED: { word: "CAPTURED", line: "Paid to the seller.", tone: "bg-green text-paper", icon: <Icon><path d="M15 25l6 6 12-13" /></Icon> },
  REVERSED: { word: "REVERSED", line: "Hold reversed: the buyer keeps the money.", tone: "bg-red text-paper", icon: <Icon><path d="M17 17l14 14M31 17L17 31" /></Icon> },
  REFUSED: { word: "REFUSED", line: "Visa refused to settle and did not apply it.", tone: "bg-sand text-ink", icon: <Icon><path d="M10 38L38 10" /></Icon> },
  UNKNOWN: { word: "UNKNOWN", line: "Visa did not answer. It may have settled: do not retry. Check the Visa Business Center.", tone: "bg-ink text-paper", icon: <Icon><path d="M24 13v14" /><path d="M24 34v.5" /></Icon> },
  CLOSED: { word: "CLOSED", line: "Released or lapsed: the pickup never happened.", tone: "bg-sand text-ink", icon: <Icon><path d="M16 24h16" /></Icon> },
};

/** Short tones, used when the spoken verdict is off or has nothing to say (HELD, UNKNOWN, REFUSED). */
let audioCtx: AudioContext | null = null;
function tone(state: KioskState) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audioCtx ??= new Ctx();
    const notes: Record<KioskState, number[]> = { IDLE: [], HELD: [523], NEEDS_CHECK: [523, 523], CAPTURED: [659, 880], REVERSED: [440, 294],
      REFUSED: [330, 330, 330], UNKNOWN: [330, 330, 330], CLOSED: [392] };
    notes[state].forEach((f, i) => {
      const o = audioCtx!.createOscillator();
      const g = audioCtx!.createGain();
      const t = audioCtx!.currentTime + i * 0.18;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.connect(g).connect(audioCtx!.destination);
      o.start(t);
      o.stop(t + 0.16);
    });
  } catch {}
}

/** The ElevenLabs spoken verdict (the same /api/voice line /pickup plays), else a tone. Never awaited by settlement. */
let voice: HTMLAudioElement | null = null;
async function announce(state: KioskState, kind: VerdictKind | undefined) {
  if (kind && (state === "CAPTURED" || state === "REVERSED" || state === "NEEDS_CHECK")) {
    try {
      const ac = new AbortController();
      const timer = window.setTimeout(() => ac.abort(), 6000);
      const r = await fetch(`/api/voice?kind=${kind}&lang=en`, { signal: ac.signal });
      window.clearTimeout(timer);
      if (r.ok) {
        voice?.pause();
        voice = new Audio(URL.createObjectURL(await r.blob()));
        await voice.play();
        return;
      }
    } catch {}
  }
  tone(state);
}

/** Re-reads this deal's record when the change stream reports it (every 3 s without a stream). */
function RecordFeed({ dealId, onRecord }: { dealId: string; onRecord: (r: DealRecord | null, httpStatus: number) => void }) {
  const latest = useRef(onRecord);
  useEffect(() => { latest.current = onRecord; }, [onRecord]);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const r = await fetch(`/api/deals/${encodeURIComponent(dealId)}`, { cache: "no-store" });
      const j = r.ok ? ((await r.json()) as DealRecord) : null;
      if (n === seq.current) latest.current(j, r.status); // a newer read has started: never apply an older answer
    } catch {
      if (n === seq.current) latest.current(null, 0);
    }
  }, [dealId]);
  const mode = useLiveRefresh(`/api/stream?deal=${encodeURIComponent(dealId)}`, load);
  return <span data-testid="live-mode">{LIVE_LABEL[mode]}</span>;
}

export function Checkpoint() {
  const [local, setLocal] = useState<Local | null>(null);
  const localRef = useRef<Local | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [record, setRecord] = useState<{ r: DealRecord | null; http: number } | null>(null);
  const [tabDeal, setTabDeal] = useState<Stored | null>(null);
  const [paste, setPaste] = useState("");
  const [upcText, setUpcText] = useState("");
  const [lastScan, setLastScan] = useState<{ upc: string; source: "scanner" | "keyboard" } | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [sound, setSound] = useState(true);
  const inFlight = useRef(false);
  const wedge = useRef(new WedgeBuffer());
  const upcInput = useRef<HTMLInputElement>(null);

  const commit = useCallback((next: Local | null) => {
    localRef.current = next;
    setLocal(next);
    if (next?.source === "tab") writeBack(next);
  }, []);
  /** Settlement results only ever replace a deal that is still HELD (a late or duplicate reply cannot overwrite a final one). */
  const settleTo = useCallback((patch: Partial<Local>) => {
    const cur = localRef.current;
    if (cur && cur.status === "HELD") commit({ ...cur, ...patch });
  }, [commit]);

  function attachFromTab(s: Stored) {
    const view = s.token ? readDealToken(s.token) : null;
    if (!view || !s.status) { setErr("The deal in this tab has no token to settle with."); return; }
    setErr(""); setVerdict(null); setRecord(null);
    commit({ token: view.token, dealId: view.dealId, amountUsd: s.amountUsd ?? view.amountUsd, listing: s.listing, status: s.status, source: "tab" });
  }

  // read this tab's deal (the one /pickup holds); attach it when it is still open
  useEffect(() => {
    const s = readStored();
    if (!s?.token) return;
    const open = (s.status === "HELD" && !stale(s.at)) || s.status === "UNKNOWN";
    window.setTimeout(() => { setTabDeal(s); if (open) attachFromTab(s); }, 0); // deferred: no state set inside the effect itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function attachPasted() {
    const view = readDealToken(paste);
    if (!view) { setErr("That is not a deal token. Paste the token from the buyer's pickup page."); return; }
    setErr(""); setVerdict(null); setRecord(null); setPaste("");
    setBusy("Looking up this deal…");
    let status: DealStatus = "HELD";
    let listing: string | undefined;
    let unconfirmed = true;
    try {
      const r = await fetch(`/api/deals/${encodeURIComponent(view.dealId)}`, { cache: "no-store" });
      if (r.ok) { const j = (await r.json()) as DealRecord; status = j.status; listing = j.listing; unconfirmed = false; }
    } catch {}
    setBusy("");
    commit({ token: view.token, dealId: view.dealId, amountUsd: view.amountUsd, listing, status, source: "pasted", unconfirmed });
  }

  const onRecord = useCallback((r: DealRecord | null, http: number) => {
    setRecord({ r, http });
    const cur = localRef.current;
    if (!r || !cur || inFlight.current) return;
    if (cur.status === "HELD" && cur.unconfirmed) commit({ ...cur, unconfirmed: false });
    const next = mergeRecord(cur.status, r.status);
    if (next !== cur.status) settleTo({ status: next, passportPath: r.passportPath ?? undefined }); // settled from another device
  }, [commit, settleTo]);

  const settle = useCallback(async (upc: string, source: "scanner" | "keyboard") => {
    const cur = localRef.current;
    setLastScan({ upc, source });
    if (!cur) { setErr("No deal attached. Attach the buyer's deal first; nothing was sent."); return; }
    if (!canSettle(cur.status)) { setErr(`This deal is ${cur.status}. Only an open hold is settled here; nothing was sent.`); return; }
    if (inFlight.current) return;
    inFlight.current = true;
    setErr("");
    setBusy("Checking recalls and settling the hold with Visa…");
    try {
      let r: Response;
      try {
        r = await fetch("/api/pickup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: cur.token, upc }) });
      } catch {
        // the settle request may have reached the server: UNKNOWN, so this kiosk never re-posts the token
        settleTo({ status: "UNKNOWN", reason: "connection lost" });
        setErr("The connection dropped while settling. The hold may or may not have settled: do not retry, check the Visa Business Center.");
        return;
      }
      const j = (await r.json().catch(() => ({ error: `The server answered HTTP ${r.status} without a result.` }))) as
        { verdict?: Verdict; status?: DealStatus; visa?: { id?: string; reason?: string }; passport?: { path?: string; error?: string }; error?: string };
      if (!r.ok || !j.verdict) {
        // 400 (our validation), 403 (bad token) and 503 (no Visa keys) are answered before Visa is called
        if (![400, 403, 503].includes(r.status)) settleTo({ status: "UNKNOWN", reason: `HTTP ${r.status}` });
        setErr(`${j.error ?? `HTTP ${r.status}`}${DO_NOT_RETRY}`);
        return;
      }
      setVerdict(j.verdict);
      if (j.status) settleTo({ status: j.status, settlementId: j.visa?.id, reason: j.visa?.reason, passportPath: j.passport?.path, passportError: j.passport?.error });
    } finally {
      inFlight.current = false;
      setBusy("");
    }
  }, [settleTo]);

  const feed = useCallback((key: string, t: number) => {
    const res = wedge.current.key(key, t);
    setUpcText(wedge.current.digits);
    if (!res) return;
    if (res.kind === "reject") { setErr(`${res.reason} Nothing was sent.`); return; }
    void settle(res.upc, res.source);
  }, [settle]);

  // a scanner types into whatever has focus: keys typed outside any field still reach the wedge
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(el.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^\d$/.test(e.key) || e.key === "Enter" || e.key === "Backspace") { e.preventDefault(); feed(e.key, e.timeStamp); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [feed]);

  const state = kioskState(local?.status ?? null,
    local?.status === "HELD" ? (verdict?.kind ?? record?.r?.verdict?.kind ?? null) : verdict?.kind ?? null);
  const spokenKind = verdict?.kind ?? record?.r?.verdict?.kind;

  // one sound per state change (never on first paint, never blocking the settlement)
  const prevState = useRef<KioskState | null>(null);
  useEffect(() => {
    const prev = prevState.current;
    prevState.current = state;
    if (prev === null || prev === state || state === "IDLE" || !sound) return;
    void announce(state, spokenKind);
  }, [state, spokenKind, sound]);

  useEffect(() => { if (state === "HELD" || state === "NEEDS_CHECK") upcInput.current?.focus(); }, [state]);

  const ui = UI[state];
  const shownVerdict = verdict;
  const recordReason = !verdict && record?.r?.verdict ? record.r.verdict.reason : null;
  const settleable = !!local && canSettle(local.status);

  return (
    <main className="min-h-dvh bg-sand text-ink p-3 sm:p-4 grid gap-3 sm:gap-4 grid-rows-[auto_1fr_auto]">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[1.75rem] sm:rounded-full border-[3px] border-ink bg-paper px-4 py-2">
        <Link href="/" className="display text-2xl">{BRAND}</Link>
        <span className="text-xs sm:text-sm font-extrabold tracking-wider">PICKUP CHECKPOINT</span>
        <span className="ml-auto flex flex-wrap items-center gap-2 text-sm font-bold">
          <button type="button" onClick={() => setSound((s) => !s)} aria-pressed={sound} className="rounded-full border-2 border-ink px-3 py-1">
            Sound {sound ? "on" : "off"}
          </button>
          <button type="button" onClick={() => { document.documentElement.requestFullscreen?.().catch(() => {}); }} className="rounded-full border-2 border-ink px-3 py-1">
            Full screen
          </button>
          <Link href="/board" className="underline decoration-2 underline-offset-4">Board</Link>
        </span>
      </header>

      <section aria-live="polite" data-testid="kiosk-state" data-state={state}
        className={`rounded-[2rem] sm:rounded-[3rem] border-[3px] border-ink p-6 sm:p-10 grid content-center gap-4 ${ui.tone}`}>
        <div className="flex items-center gap-4 sm:gap-8">
          {ui.icon}
          <div className="min-w-0">
            <p className="display text-[clamp(3.2rem,12vw,11rem)] break-words">{ui.word}</p>
            <p className="mt-2 text-lg sm:text-2xl font-bold max-w-[34em]">{ui.line}</p>
          </div>
        </div>
        {local && (
          <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
            <p className="display text-[clamp(3rem,10vw,8rem)]" data-testid="kiosk-amount">${local.amountUsd.toFixed(2)}</p>
            <p className="text-lg sm:text-xl font-bold opacity-85 pb-2 min-w-0 break-words">{local.listing ?? record?.r?.listing ?? "a listing"}</p>
          </div>
        )}
        {shownVerdict && (
          <p className="text-lg sm:text-xl font-bold">
            {VERDICT_LABEL[shownVerdict.kind]}: {shownVerdict.reason}
            {shownVerdict.recall && <> <a href={shownVerdict.recall.url} target="_blank" rel="noreferrer" className="underline">Read CPSC {shownVerdict.recall.recallNumber}</a></>}
          </p>
        )}
        {recordReason && <p className="text-lg font-bold">{recordReason}</p>}
        {local?.status === "REFUSED" && local.reason && (
          <p className="font-bold">Visa&apos;s reason: {local.reason}{local.reason === "MISSING_AUTH" ? " (this hold was already settled or is not open)" : ""}</p>
        )}
        {local && (
          <dl className="text-xs sm:text-sm font-mono grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 opacity-90">
            <dt>deal</dt><dd className="break-all">{local.dealId}</dd>
            {local.settlementId && (local.status === "CAPTURED" || local.status === "REVERSED") && <><dt>{local.status === "CAPTURED" ? "capture" : "reversal"}</dt><dd className="break-all">{local.settlementId}</dd></>}
            {record?.r && <><dt>deal record</dt><dd>{record.r.status}{record.r.status !== local.status ? " (this kiosk keeps what Visa told it)" : ""}</dd></>}
            {local.passportPath && <><dt>passport</dt><dd><a href={local.passportPath} className="underline font-bold">Solana devnet record</a></dd></>}
            {local.passportError && <><dt>passport</dt><dd>{local.passportError}</dd></>}
          </dl>
        )}
      </section>

      <section className="rounded-[2rem] border-[3px] border-ink bg-paper p-4 sm:p-6 grid gap-4 lg:grid-cols-[1.2fr_1fr] items-start">
        {local ? (
          <form className="grid gap-2" onSubmit={(e) => e.preventDefault()}>
            <label htmlFor="kiosk-upc" className="text-sm font-extrabold tracking-wider">
              {settleable ? "SCAN THE BARCODE, OR TYPE THE UPC AND PRESS ENTER" : "SETTLED: NO FURTHER SCANS FOR THIS DEAL"}
            </label>
            {settleable && <input id="kiosk-upc" ref={upcInput} value={upcText} inputMode="numeric" autoComplete="off" disabled={!settleable || !!busy}
              aria-describedby="kiosk-upc-help"
              onChange={(e) => { wedge.current.set(e.target.value); setUpcText(wedge.current.digits); }}
              onKeyDown={(e) => {
                if (e.metaKey || e.ctrlKey || e.altKey) return;
                if (/^\d$/.test(e.key) || e.key === "Enter" || e.key === "Backspace") { e.preventDefault(); feed(e.key, e.timeStamp); }
              }}
              placeholder="UPC"
              className="w-full rounded-2xl border-[3px] border-ink bg-paper px-4 py-3 font-mono text-3xl sm:text-4xl tracking-widest focus:outline-none focus:ring-4 focus:ring-amber disabled:opacity-50" />}
            <p id="kiosk-upc-help" className="text-sm font-semibold text-ink/70">
              A USB barcode scanner works as soon as it is plugged in: it types the code and presses Enter. The UPC is checked against the CPSC recall index and settles the hold: a recall reverses it, no match captures it, anything uncertain keeps it held.
            </p>
            {busy && <p role="status" className="font-bold">{busy}</p>}
            {lastScan && <p className="text-sm font-bold" data-testid="kiosk-last-scan">Last code: <span className="font-mono">{lastScan.upc}</span> ({lastScan.source === "scanner" ? "from the scanner" : "typed"})</p>}
          </form>
        ) : (
          <div className="grid gap-3">
            <p className="text-sm font-extrabold tracking-wider">ATTACH THE BUYER&apos;S DEAL</p>
            {tabDeal?.token && (
              <button type="button" onClick={() => attachFromTab(tabDeal)} className="justify-self-start rounded-full border-[3px] border-ink bg-amber px-5 py-2.5 font-extrabold">
                Use the deal in this tab (${(tabDeal.amountUsd ?? 0).toFixed(2)}, {tabDeal.status})
              </button>
            )}
            <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void attachPasted(); }}>
              <label htmlFor="kiosk-token" className="text-sm font-bold">Or paste the deal token from the buyer&apos;s pickup page</label>
              <textarea id="kiosk-token" value={paste} onChange={(e) => setPaste(e.target.value)} rows={2} spellCheck={false}
                className="w-full rounded-xl border-2 border-ink px-3 py-2 font-mono text-sm focus:outline-none focus:ring-4 focus:ring-amber" />
              <button type="submit" disabled={!paste.trim() || !!busy} className="justify-self-start rounded-full border-[3px] border-ink bg-ink text-paper px-5 py-2.5 font-extrabold disabled:opacity-50">Attach deal</button>
            </form>
            <p className="text-sm font-semibold text-ink/70">
              No deal yet? <Link href="/pickup" className="underline font-bold">Hold one on /pickup</Link>, then come back here in the same tab.
            </p>
          </div>
        )}
        <div className="grid gap-2 text-sm font-semibold">
          {err && <p role="alert" data-testid="kiosk-error" className="rounded-xl border-2 border-ink bg-red-soft text-red-deep p-3 font-bold">{err}</p>}
          {local?.unconfirmed && local.status === "HELD" && (
            <p className="rounded-xl bg-amber-soft p-3">No deal record confirms this hold is still open. A scan asks Visa directly; if the hold was already settled, Visa refuses and nothing moves twice.</p>
          )}
          {local && (
            <p>
              {local.source === "tab" ? <>Camera instead of a scanner: <Link href="/pickup" className="underline font-bold">photograph the label on /pickup</Link> (same deal, this tab).</>
                : <>This deal was pasted in, so the camera path on /pickup does not have it; use the scanner or type the UPC.</>}
            </p>
          )}
          {local && <p className="text-ink/60">Deal record: <RecordFeed dealId={local.dealId} onRecord={onRecord} />{record && !record.r && record.http ? ` (not available: HTTP ${record.http})` : ""}</p>}
          {local && !busy && (
            <button type="button" onClick={() => { commit(null); setTabDeal(readStored()); setVerdict(null); setRecord(null); setLastScan(null); setErr(""); wedge.current.reset(); setUpcText(""); }}
              className="justify-self-start rounded-full border-2 border-ink px-4 py-2 font-extrabold">
              Detach this deal from the kiosk
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
