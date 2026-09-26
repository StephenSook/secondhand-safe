"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { SquashButton } from "./SquashButton";
import { SpeakVerdict } from "./SpeakVerdict";

/**
 * Discovery and decision (PLAN 2.7): the parent says or types what they need, Gemini turns it into filters over
 * real scanned listings, every result arrives pre-screened, and "Buy with our agent" places a TAP-signed Visa
 * hold that the pickup scan later captures or reverses.
 */
type Screen = { tone: "red" | "amber" | "clear"; kind: string; headline: string; reason: string };
type Listing = { id: string; source: string; region: string | null; url: string; image: string | null; title: string; priceUsd: number | null };
type Result = { listing: Listing; screen: Screen };
type ShopResponse = { engine: "gemini" | "keywords"; reply: string; results: Result[]; counts: { red: number; amber: number; clear: number }; ms: number; error?: string };
type Held = { id: string; ok: boolean; text: string };

const EXAMPLES = ["A bassinet for my newborn under $80, pickup in Atlanta", "Infant sleeper for the bed", "Crib under $100 near Atlanta", "Baby car seat under $60"];
const AGENT_MAX = 200;
const TONE = {
  red: { bg: "bg-red-soft", chip: "bg-red text-paper", icon: "✕" },
  amber: { bg: "bg-amber-soft", chip: "bg-amber text-ink", icon: "!" },
  clear: { bg: "bg-green-soft", chip: "bg-green text-paper", icon: "✓" },
};

type SR = { lang: string; interimResults: boolean; onresult: (e: { results: { 0: { transcript: string } }[] }) => void; onend: () => void; onerror: () => void; start: () => void };
const speechCtor = (): (new () => SR) | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export function ShopAgent() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [res, setRes] = useState<ShopResponse | null>(null);
  const [err, setErr] = useState("");
  const [held, setHeld] = useState<Held | null>(null);
  const [buying, setBuying] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [voiceMsg, setVoiceMsg] = useState("");

  /** ElevenLabs reads the summary back. The server builds the sentence from the four counts only. */
  async function speakSummary(r: ShopResponse, lang: "en" | "es") {
    setVoiceMsg("…");
    try {
      const c = r.counts;
      const resp = await fetch(`/api/voice?summary=${r.results.length},${c.red},${c.amber},${c.clear}&lang=${lang}`);
      if (resp.status === 503) { setVoiceMsg("Voice is off on this deployment."); return; }
      if (!resp.ok) throw new Error(String(resp.status));
      audio.current?.pause();
      audio.current = new Audio(URL.createObjectURL(await resp.blob()));
      await audio.current.play();
      setVoiceMsg("");
    } catch {
      setVoiceMsg("Could not play the voice.");
    }
  }

  async function run(query = q) {
    const text = query.trim();
    if (!text) return;
    setQ(text); setBusy(true); setErr(""); setHeld(null);
    try {
      const r = await fetch("/api/shop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: text }) });
      const j = (await r.json()) as ShopResponse;
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setRes(j);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function listen() {
    const Ctor = speechCtor();
    if (!Ctor) { setErr("This browser has no speech input; type the request instead."); return; }
    const rec = new Ctor();
    rec.lang = "en-US"; rec.interimResults = false;
    rec.onresult = (e) => { const t = e.results[0][0].transcript; setQ(t); void run(t); };
    rec.onend = () => setListening(false);
    rec.onerror = () => { setListening(false); setErr("Did not catch that; try again or type it."); };
    setListening(true); rec.start();
  }

  async function buy(r: Result) {
    const l = r.listing;
    setBuying(l.id); setHeld(null);
    try {
      const resp = await fetch("/api/agent/checkout", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ listingId: l.id }) });
      const j = await resp.json();
      const m = j.merchant ?? {};
      if (!resp.ok || m.status !== "HELD") throw new Error(m.error ?? j.error ?? `HTTP ${resp.status}`);
      let handoff = true;
      try {
        sessionStorage.setItem("shs-deal", JSON.stringify({ dealId: m.dealId, listing: m.listing, amountUsd: m.amountUsd, token: m.token,
          authId: m.visa.authId, status: "HELD", at: m.at, card: m.card }));
      } catch {
        handoff = false; // private mode or storage blocked: the pickup page could not find this hold
      }
      setHeld({ id: l.id, ok: handoff, text: !handoff ? `HELD $${m.amountUsd.toFixed(2)} at Visa (authorization ${m.visa.authId}), but this browser blocked storage, so the pickup page cannot pick it up. It lapses on its own if nobody captures it.` : `HELD $${m.amountUsd.toFixed(2)} at Visa. The agent signed the checkout (Trusted Agent Protocol, key ${m.tap?.keyid ?? "?"}) and our merchant verified it before calling Visa. Nothing is charged until the label passes at pickup.` });
    } catch (e) {
      setHeld({ id: l.id, ok: false, text: `No hold was placed: ${(e as Error).message}` });
    } finally {
      setBuying("");
    }
  }

  return (
    <div className="grid gap-6">
      <form onSubmit={(e) => { e.preventDefault(); void run(); }} className="rounded-[2rem] border-[3px] border-ink bg-paper p-5 sm:p-6 shadow-[6px_8px_0_var(--ink)]">
        <label htmlFor="shop-q" className="text-sm font-extrabold tracking-wider">TELL THE AGENT WHAT YOU NEED</label>
        <div className="mt-3 flex flex-col sm:flex-row gap-3">
          <input id="shop-q" ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} maxLength={400}
            placeholder="a bassinet for my newborn under $80, pickup in Atlanta"
            className="flex-1 h-14 rounded-2xl border-[3px] border-ink bg-sand/40 px-4 text-lg font-semibold" />
          <div className="flex gap-3">
            <button type="button" onClick={listen} disabled={busy || listening} aria-label="Speak your request"
              className={`h-14 w-14 rounded-2xl border-[3px] border-ink text-2xl font-bold ${listening ? "bg-red text-paper animate-pulse" : "bg-aqua"}`}>
              {listening ? "●" : "🎙"}
            </button>
            <SquashButton type="submit" disabled={busy || !q.trim()} accent="var(--amber)">{busy ? "Searching…" : "Find it"}</SquashButton>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((x) => (
            <button key={x} type="button" onClick={() => void run(x)} disabled={busy}
              className="rounded-full border-2 border-ink bg-sand px-3 py-1 text-sm font-bold hover:bg-amber-soft">{x}</button>
          ))}
        </div>
        {err && <p role="alert" className="mt-3 font-bold text-red-deep">{err}</p>}
      </form>

      {res && (
        <div aria-live="polite" className="grid gap-4">
          <div className="rounded-[2rem] border-[3px] border-ink bg-ink text-paper p-5">
            <p className="text-xs font-extrabold tracking-wider opacity-70">
              {res.engine === "gemini" ? "GEMINI 3.5 FLASH READ YOUR REQUEST" : "KEYWORD SEARCH (GEMINI UNREACHABLE)"} · {res.ms} ms
            </p>
            <p className="mt-1 text-xl font-bold">{res.reply}</p>
            <p className="mt-2 font-semibold">
              {res.results.length} real listings, each pre-screened before you message anyone:{" "}
              <span className="text-red-soft">{res.counts.red} blocked</span> ·{" "}
              <span className="text-amber-soft">{res.counts.amber} need a check</span> ·{" "}
              <span className="text-green-soft">{res.counts.clear} photo check passed</span>
            </p>
            {res.results.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {(["en", "es"] as const).map((lang) => (
                  <button key={lang} type="button" onClick={() => speakSummary(res, lang)}
                    className="rounded-full border-2 border-paper px-3 py-1 text-sm font-extrabold hover:bg-paper hover:text-ink">
                    <span aria-hidden>🔊</span> {lang === "en" ? "Hear it" : "Escúchalo en español"}
                  </button>
                ))}
                {voiceMsg && <span className="text-sm font-semibold opacity-80">{voiceMsg}</span>}
              </div>
            )}
          </div>
          {res.results.length === 0 && <p className="hand text-3xl">Nothing matched. Try fewer words or a higher budget.</p>}
          <ul className="grid gap-4 md:grid-cols-2">
            {res.results.map((r) => {
              const t = TONE[r.screen.tone];
              const l = r.listing;
              const price = l.priceUsd ?? 0;
              const canBuy = r.screen.tone !== "red" && price >= 1 && price <= AGENT_MAX;
              return (
                <li key={l.id} data-tone={r.screen.tone} className={`rounded-[1.75rem] border-[3px] border-ink ${t.bg} p-4 grid grid-cols-[6.5rem_1fr] gap-4`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={l.image ?? ""} alt={l.title} loading="lazy" referrerPolicy="no-referrer"
                    className="w-[6.5rem] h-[6.5rem] object-cover rounded-xl border-2 border-ink bg-white" />
                  <div className="min-w-0">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-extrabold ${t.chip}`}>
                      <span aria-hidden>{t.icon}</span>{r.screen.headline}
                    </span>
                    <p className="mt-1 font-extrabold leading-tight line-clamp-2">{l.title}</p>
                    <p className="text-sm font-semibold opacity-80">
                      <b className="display text-lg">${price.toFixed(2)}</b> · {l.source === "ebay" ? "eBay" : `Craigslist${l.region ? ` ${l.region}` : ""}`} ·{" "}
                      <a href={l.url} target="_blank" rel="noreferrer" className="underline">listing</a>
                    </p>
                  </div>
                  <p className="col-span-2 text-sm font-semibold">{r.screen.reason}</p>
                  <div className="col-span-2 flex flex-wrap items-center gap-3">
                    {canBuy ? (
                      <button type="button" onClick={() => void buy(r)} disabled={!!buying}
                        className="rounded-full border-[3px] border-ink bg-visa text-paper px-4 py-2 font-extrabold disabled:opacity-50">
                        {buying === l.id ? "Signing and holding…" : `Buy with our agent: hold $${price.toFixed(2)}`}
                      </button>
                    ) : (
                      <span className="text-sm font-extrabold">
                        {r.screen.tone === "red" ? "Blocked: the agent will not buy this." : price > AGENT_MAX ? `Over the agent's $${AGENT_MAX} limit.` : "No price listed."}
                      </span>
                    )}
                    {r.screen.tone === "red" && r.screen.kind === "BANNED_TYPE" && <SpeakVerdict kind="BANNED_TYPE" />}
                  </div>
                  {held?.id === l.id && (
                    <div role="status" className={`col-span-2 rounded-xl border-2 border-ink p-3 font-bold ${held.ok ? "bg-amber" : "bg-red-soft"}`}>
                      {held.text}
                      {held.ok && <Link href="/pickup" className="ml-2 underline">Meet the seller: open the pickup scan →</Link>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-xs font-semibold text-ink/60">
            Listings are real eBay and Craigslist posts we harvested on 2026-09-26 and scanned with our model; prices and
            availability are as of then. Gemini only reads your request. The verdicts come from the CPSC and NHTSA recall
            index, our trained photo model and our own review, and none of them means an item is safe.
          </p>
        </div>
      )}
    </div>
  );
}
