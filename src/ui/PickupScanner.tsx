"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { STORAGE_BLOCKED, stale, clearPending, explicitlyNoHold, markPending, noSubscribe, openHold, readBoth } from "./holdGuard";
import { CardFields, type CardState } from "./CardFields";
import { DEMO_TABLE } from "@/core/demoTable";
import type { Verdict } from "@/core/verdict";
import { VERDICT_LABEL, CAPTURABLE } from "@/core/verdict";
import type { ClipHead, ClassifyResult } from "@/core/clipHead";
import type { LabelRead } from "@/server/ml/label";
import type { LookAlike } from "@/server/db/vector";
import { SquashButton } from "./SquashButton";
import { SpeakVerdict } from "./SpeakVerdict";
import { WatchThisItem } from "./WatchThisItem";
import { setupGsap, gsap, prefersReducedMotion } from "./motion/gsap";

type Health = { integrations: Record<string, boolean> };
type Deal = {
  dealId: string; listing: string; amountUsd: number; token: string; authId: string;
  status: "HELD" | "CAPTURED" | "REVERSED" | "REFUSED" | "UNKNOWN"; settlementId?: string; reason?: string; at: string;
  /** which card Visa held: the parent's Microform entry, or the sandbox test card (agent path, or no fields) */
  card?: "microform" | "sandbox-test-card" | "saved-card";
  /** Solana devnet item passport written at capture: a link to verify it, or why it was not written */
  passportPath?: string; passportError?: string;
  /** a Visa card-linked offer applied at authorization (the hold is the discounted amount) */
  promotion?: { description: string; discountUsd: number; receipt: string }; askedUsd?: number;
};
const DEAL_KEY = "shs-deal";
const SAVED_KEY = "lullabuy-saved-card";
/** A saved-card entry from localStorage, or null if missing, corrupt or the wrong shape. */
function parseSaved(raw: string | null): { token: string; masked: string } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { token?: unknown; masked?: unknown };
    return typeof v?.token === "string" && typeof v?.masked === "string" ? { token: v.token, masked: v.masked } : null;
  } catch {
    return null;
  }
}
const LISTINGS = DEMO_TABLE;
const CLASS_NAME: Record<string, string> = {
  inclined_or_inbed_sleeper: "infant sleeper", crib_bumper: "crib bumper", drop_side_crib: "drop-side crib", other: "no banned type",
};

/** Resize to at most 1600px and re-encode, so phone photos upload fast and fit the label reader's limit. */
async function toDataUrl(file: Blob, max = 1600): Promise<string> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.88);
}

async function detectBarcode(file: Blob): Promise<string | undefined> {
  const BD = (globalThis as unknown as { BarcodeDetector?: new (o: object) => { detect: (b: ImageBitmap) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  if (!BD) return undefined;
  try {
    const found = await new BD({ formats: ["upc_a", "upc_e", "ean_13", "ean_8"] }).detect(await createImageBitmap(file));
    return found[0]?.rawValue;
  } catch {
    return undefined;
  }
}

export function PickupScanner() {
  const [health, setHealth] = useState<Health | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [fields, setFields] = useState({ model: "", batch: "", date: "", upc: "", text: "" });
  const [label, setLabel] = useState<LabelRead | null>(null);
  const [labelMsg, setLabelMsg] = useState("");
  const [cls, setCls] = useState<ClassifyResult | null>(null);
  const [clsMsg, setClsMsg] = useState("");
  // closest CPSC recall photos to this photo (MongoDB Atlas Vector Search); a comparison aid, never a verdict
  const [look, setLook] = useState<{ matches: LookAlike[] } | { error: string } | null>(null);
  const lookFor = useRef(0); // which photo a look-alike answer belongs to; a late answer for an older photo is dropped
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [busy, setBusy] = useState("");
  const [deal, setDeal] = useState<Deal | null>(null);
  const [dealErr, setDealErr] = useState("");
  const [pick, setPick] = useState(0);
  const [card, setCard] = useState<CardState>({ state: "loading" });
  // Visa Token Management Service: this browser keeps only our signed wrapper around Visa's customer token
  const [saved, setSaved] = useState<{ token: string; masked: string } | null>(null);
  const [useSaved, setUseSaved] = useState(true);
  const [saveCard, setSaveCard] = useState(false);
  const forgetSaved = () => { try { localStorage.removeItem(SAVED_KEY); } catch {} setSaved(null); };
  const decisionRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const dealRef = useRef<Deal | null>(null);
  dealRef.current = deal;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
    try {
      const savedDeal = sessionStorage.getItem(DEAL_KEY);
      const restoredDeal = savedDeal ? (JSON.parse(savedDeal) as Deal) : null;
      // a hold past its 12 h pickup-token life can no longer be settled here (the daily sweeper releases it at Visa)
      // only an unsettled HELD hold is dropped; an UNKNOWN settlement stays until the buyer acknowledges it
      if (restoredDeal && restoredDeal.status === "HELD" && stale(restoredDeal.at)) sessionStorage.removeItem(DEAL_KEY);
      else if (restoredDeal) window.setTimeout(() => setDeal(restoredDeal), 0);
      const parsed = parseSaved(localStorage.getItem(SAVED_KEY));
      if (parsed) window.setTimeout(() => setSaved(parsed), 0);
    } catch {}
  }, []);

  /** Returns whether the deal reached storage (the pending marker is only cleared when it did). */
  const saveDeal = (d: Deal | null): boolean => {
    dealRef.current = d;
    setDeal(d);
    try { if (d) sessionStorage.setItem(DEAL_KEY, JSON.stringify(d)); else sessionStorage.removeItem(DEAL_KEY); return true; } catch { return false; }
  };

  const [agentMsg, setAgentMsg] = useState<{ ok: boolean; text: string; sig?: string } | null>(null);

  // one open hold at a time across /shop and /pickup (src/ui/holdGuard.ts)
  const [, bumpGuard] = useState(0);
  const guardSnap = useSyncExternalStore(noSubscribe, readBoth, () => "\n");
  const pendingHold = (() => { const h = openHold(guardSnap); return h?.pending ? h : null; })();
  /** Refuses (with the reason) when a hold MAY already exist, then writes the pending marker. */
  function beginHold(): boolean {
    const existing = openHold();
    if (existing) { setDealErr(existing.text); bumpGuard((n) => n + 1); return false; }
    if (!markPending({ listingId: `table:${pick}`, listing: LISTINGS[pick].label, amountUsd: LISTINGS[pick].amountUsd })) { setDealErr(STORAGE_BLOCKED); return false; }
    bumpGuard((n) => n + 1);
    return true;
  }
  function endHold(noHold: boolean) {
    if (noHold) clearPending();
    bumpGuard((n) => n + 1);
  }

  async function agentBuy(tamper: boolean) {
    setDealErr("");
    setAgentMsg(null);
    if (!beginHold()) return;
    let noHold = false; // cleared only on a confirmed hold or an explicit placed:false
    setBusy(tamper ? "Sending a request edited after signing…" : "Our agent is signing the checkout (Trusted Agent Protocol)…");
    try {
      const r = await fetch("/api/agent/checkout", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ listing: LISTINGS[pick].label, amountUsd: LISTINGS[pick].amountUsd, tamper }) });
      const j = await r.json();
      if (!r.ok) { noHold = explicitlyNoHold(j); throw new Error(j.error ?? `HTTP ${r.status}`); }
      const m = j.merchant;
      if (m.status === "HELD" && m.token) {
        noHold = saveDeal({ dealId: m.dealId, listing: m.listing, amountUsd: m.amountUsd, token: m.token, authId: m.visa.authId, status: "HELD", at: m.at, card: m.card }); // the stored deal replaces the pending marker
        setVerdict(null);
        setAgentMsg({ ok: true, text: `The merchant checked the signature: this came from our registered agent (key ${m.tap?.keyid}) and was not altered on the way. Then Visa held the payment.`, sig: j.agent["signature-input"] });
      } else {
        noHold = explicitlyNoHold(j);
        setAgentMsg({ ok: false, text: `Merchant refused (HTTP ${m.httpStatus}): ${m.error ?? "unknown"}. Signed $${j.agent.signed.amountUsd}, sent $${j.agent.sent.amountUsd}.`, sig: j.agent["signature-input"] });
      }
    } catch (e) {
      setDealErr((e as Error).message);
    } finally {
      endHold(noHold);
      setBusy("");
    }
  }

  async function startDeal() {
    setDealErr("");
    const usingSaved = !!(useSaved && saved);
    if (!usingSaved && card.state === "loading") return setDealErr("Visa's card fields are still loading.");
    const existing = openHold();
    if (existing) { setDealErr(existing.text); return; }
    let noHold = false;
    setBusy(!usingSaved && card.state === "ready" ? "Visa is sealing the card into a one-time token…" : "Asking Visa to authorize and hold…");
    try {
      const transientTokenJwt = !usingSaved && card.state === "ready" ? await card.tokenize() : undefined;
      // the pending marker goes down only now, right before Visa is called: a card-field error above left no hold
      if (!beginHold()) return;
      setBusy("Asking Visa to authorize and hold…");
      const r = await fetch("/api/checkout", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ listing: LISTINGS[pick].label, amountUsd: LISTINGS[pick].amountUsd,
          ...(usingSaved ? { savedCard: saved!.token } : { transientTokenJwt, saveCard: !!transientTokenJwt && saveCard }) }) });
      const j = await r.json();
      if (!r.ok) {
        if (usingSaved && r.status === 400) { forgetSaved(); }
        noHold = explicitlyNoHold(j);
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      if (j.savedCard) {
        const next = { token: j.savedCard as string, masked: String(j.savedMasked ?? "card") };
        try {
          localStorage.setItem(SAVED_KEY, JSON.stringify(next));
          setSaved(next);
        } catch {
          setDealErr("Held. Visa saved the card, but this browser blocks storage, so it cannot be offered next time.");
        }
      }
      noHold = saveDeal({ dealId: j.dealId, listing: j.listing, amountUsd: j.amountUsd, token: j.token, authId: j.visa.authId, status: "HELD", at: j.at, card: j.card,
        promotion: j.promotion, askedUsd: j.askedUsd }); // the stored deal replaces the pending marker
      setVerdict(null);
    } catch (e) {
      setDealErr((e as Error).message);
    } finally {
      endHold(noHold);
      setBusy("");
    }
  }

  async function classify(file: Blob) {
    setClsMsg("Loading the banned-type model on this device (first time about 90 MB)…");
    try {
      const [{ embedImage, loadClip }, head] = await Promise.all([
        import("@/ml/clipEmbed"),
        fetch("/models/head.json").then((r) => r.json() as Promise<ClipHead>),
      ]);
      await loadClip("q8", (p) => setClsMsg(`Loading the banned-type model on this device… ${Math.round(p)}%`));
      setClsMsg("Looking at the photo…");
      const { applyHead } = await import("@/core/clipHead");
      const emb = await embedImage(file, "q8");
      const r = applyHead(head, emb);
      setCls(r);
      // same embedding, sent to Atlas (512 numbers, never the photo)
      const mine = lookFor.current;
      void fetch("/api/lookalike", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ embedding: Array.from(emb) }) })
        .then(async (res) => { const j = await res.json(); if (lookFor.current === mine) setLook(res.ok ? { matches: j.matches } : { error: j.error ?? `HTTP ${res.status}` }); })
        .catch(() => { if (lookFor.current === mine) setLook({ error: "The look-alike search did not answer." }); });
      setClsMsg("");
      return r;
    } catch (e) {
      setClsMsg(`The on-device model could not run here (${(e as Error).message}). The label check still works.`);
      return null;
    }
  }

  async function onPhoto(file: File) {
    // never start a new photo flow while a check (possibly a Visa settlement) is still in flight
    if (inFlight.current || busy) return;
    setVerdict(null);
    setLabel(null);
    setCls(null);
    setLook(null);
    lookFor.current += 1;
    setLabelMsg("");
    const url = await toDataUrl(file);
    setPhoto(url);
    setBusy("Reading the label…");
    const [upc, lab] = await Promise.all([
      detectBarcode(file),
      fetch("/api/label", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ imageDataUrl: url }) })
        .then(async (r) => ({ ok: r.ok, j: await r.json() }))
        .catch((e) => ({ ok: false, j: { error: String(e) } })),
    ]);
    const next = { ...fields };
    if (upc) next.upc = upc;
    if (lab.ok) {
      const l = lab.j as LabelRead;
      setLabel(l);
      next.model = l.model ?? next.model;
      next.batch = l.batch ?? next.batch;
      next.date = l.date ?? next.date;
      next.upc = upc ?? l.upc ?? next.upc;
      next.text = [l.brand, l.productType].filter(Boolean).join(" ");
      if (!l.readable) setLabelMsg("The label was not legible in this photo. Retake it closer, or type the model number.");
    } else {
      setLabelMsg((lab.j as { error?: string }).error ?? "The label reader did not answer.");
    }
    setFields(next);
    setBusy("Checking the product type…");
    const c = await classify(file);
    setBusy("");
    await check(next, c);
  }

  /** Settlement results only ever replace a deal that is still HELD (a late or duplicate reply cannot
   *  overwrite a confirmed CAPTURED or REVERSED). */
  const settleTo = (patch: Partial<Deal>) => {
    const cur = dealRef.current;
    if (cur && cur.status === "HELD") saveDeal({ ...cur, ...patch });
  };

  async function check(f = fields, c = cls) {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await runCheck(f, c);
    } finally {
      inFlight.current = false;
    }
  }

  async function runCheck(f: typeof fields, c: ClassifyResult | null) {
    const deal = dealRef.current;
    const settling = deal?.status === "HELD";
    setBusy(settling ? "Checking recalls and settling the hold with Visa…" : "Checking recalls…");
    const payload = { ...f, cls: c ? { cls: c.cls, p: c.p } : undefined };
    let r: Response;
    try {
      r = await fetch(settling ? "/api/pickup" : "/api/check", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(settling ? { ...payload, token: deal!.token } : payload),
      });
    } catch {
      setBusy("");
      // the settle request may have reached the server: mark UNKNOWN so the next scan cannot re-post the token
      if (settling) settleTo({ status: "UNKNOWN", reason: "connection lost" });
      setDealErr(settling ? "The connection dropped while settling. The hold may or may not have settled: do not retry, check the Visa Business Center." : "The check did not run (connection lost). Nothing was decided.");
      return;
    }
    const j = (await r.json().catch(() => ({ error: `The server answered HTTP ${r.status} without a result.` }))) as
      { verdict?: Verdict; status?: Deal["status"]; visa?: { id?: string; reason?: string }; passport?: { path?: string; error?: string }; error?: string; settling?: boolean };
    if (r.status === 409 && j.settling) {
      // another scan (the table kiosk, another phone) is settling this hold right now; this request did not reach Visa
      setBusy("");
      setDealErr("This hold is already being settled by another scan. Nothing was sent from here; scan again in a moment to see its result.");
      return;
    }
    if (!r.ok || !j.verdict) {
      setBusy("");
      // 400 (our validation), 403 (bad token) and 503 (no Visa keys) are answered before Visa is called
      if (settling && ![400, 403, 503].includes(r.status)) settleTo({ status: "UNKNOWN", reason: `HTTP ${r.status}` });
      setDealErr(`${j.error ?? `HTTP ${r.status}`}${settling ? " The hold may or may not have settled: do not retry, check the Visa Business Center." : ""}`);
      return;
    }
    setVerdict(j.verdict);
    if (settling && j.status) settleTo({ status: j.status, settlementId: j.visa?.id, reason: j.visa?.reason, passportPath: j.passport?.path, passportError: j.passport?.error });
    setBusy("");
    requestAnimationFrame(() => {
      if (prefersReducedMotion() || !decisionRef.current) return;
      setupGsap();
      gsap.fromTo(decisionRef.current, { scale: 0.6, rotate: -8, opacity: 0 }, { scale: 1, rotate: 0, opacity: 1, duration: 0.8, ease: "elastic.out(1,0.6)" });
    });
  }

  const capture = verdict && CAPTURABLE.has(verdict.kind);
  const reverse = verdict && (verdict.kind === "RECALL_MATCH" || verdict.kind === "BANNED_TYPE");
  const visaLive = !!health?.integrations?.visa;

  return (
    <div className="grid lg:grid-cols-[1.05fr_1fr] gap-8 items-start">
      <div className="rounded-[2rem] bg-paper border-[3px] border-ink p-5 sm:p-7">
        <div className="relative aspect-[4/3] rounded-2xl bg-ink overflow-hidden grid place-items-center">
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo} alt="The label photo you took" className="absolute inset-0 w-full h-full object-contain" />
          ) : (
            <p className="hand text-3xl text-paper/70 text-center px-6">photograph the label on the back or underside</p>
          )}
          {photo && label?.boxes.map((b, i) => (
            <span key={i} className="absolute border-[3px] border-amber rounded-md shadow-[0_0_0_2000px_rgba(20,22,58,0.0)]"
              style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}>
              <span className="absolute -top-6 left-0 rounded bg-amber px-1.5 text-xs font-extrabold text-ink uppercase">{b.field}</span>
            </span>
          ))}
          {busy && <div className="absolute inset-x-3 h-1 bg-red shadow-[0_0_18px_4px_rgba(229,72,77,0.55)] animate-[scan_1.4s_ease-in-out_infinite]" />}
        </div>
        <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhoto(f); e.target.value = ""; }} />
        <div className="mt-5 flex flex-wrap gap-3 items-center">
          <SquashButton onClick={() => inputRef.current?.click()} disabled={!!busy} accent="var(--amber)">{photo ? "Retake photo" : "Take the label photo"}</SquashButton>
          {busy && <span className="font-bold text-ink/70" role="status">{busy}</span>}
        </div>
        {labelMsg && <p className="mt-4 rounded-xl bg-amber-soft p-3 font-semibold">{labelMsg}</p>}
        {clsMsg && <p className="mt-3 rounded-xl bg-aqua-soft p-3 font-semibold">{clsMsg}</p>}
        <form className="mt-6 grid sm:grid-cols-2 gap-3" onSubmit={(e) => { e.preventDefault(); check(); }}>
          {(["model", "batch", "date", "upc"] as const).map((k) => (
            <label key={k} className="block text-sm font-bold capitalize">{k === "upc" ? "UPC" : k}
              <input value={fields[k]} onChange={(e) => setFields({ ...fields, [k]: e.target.value })} autoComplete="off"
                inputMode={k === "upc" ? "numeric" : "text"}
                className="mt-1 w-full rounded-xl border-2 border-ink px-3 py-2.5 font-mono uppercase focus:outline-none focus:ring-4 focus:ring-amber" />
            </label>
          ))}
          <div className="sm:col-span-2"><SquashButton type="submit" disabled={!!busy} accent="var(--green)">Check what the label says</SquashButton></div>
        </form>
      </div>

      <div aria-live="polite" className="grid gap-5">
        <div className={`rounded-[2rem] border-[3px] border-ink p-6 ${!visaLive ? "bg-sand" : !deal ? "bg-paper" : deal.status === "HELD" ? "bg-amber" : deal.status === "CAPTURED" ? "bg-green text-paper" : deal.status === "REVERSED" ? "bg-red text-paper" : "bg-sand"}`}>
          <p className="text-sm font-extrabold tracking-wider">PAYMENT · VISA ACCEPTANCE SANDBOX</p>
          {!visaLive && (
            <>
              <p className="display text-4xl mt-1">Visa hold not connected here</p>
              <p className="mt-2 font-semibold text-ink/80">This deployment has no Visa sandbox keys yet, so the check decides what would happen to the hold.</p>
            </>
          )}
          {visaLive && !deal && (
            <>
              <p className="display text-4xl mt-1">Agree on a price</p>
              {pendingHold && (
                <p role="alert" className="mt-3 rounded-xl border-2 border-ink bg-paper p-3 text-sm font-bold">
                  {pendingHold.text}
                  <button type="button" onClick={() => { clearPending(); setDealErr(""); bumpGuard((n) => n + 1); }} className="ml-2 underline">I checked: clear it</button>
                </p>
              )}
              <div className="mt-4 grid gap-2">
                {LISTINGS.map((l, i) => (
                  <label key={l.label} className="flex items-center gap-3 rounded-xl border-2 border-ink bg-sand/60 px-3 py-2 font-semibold cursor-pointer">
                    <input type="radio" name="listing" checked={pick === i} onChange={() => setPick(i)} />
                    <span className="flex-1">{l.label}</span><b>${l.amountUsd.toFixed(2)}</b>
                  </label>
                ))}
              </div>
              {saved && (
                <div className="mt-4 rounded-2xl border-2 border-ink bg-paper/70 p-3 text-sm font-bold grid gap-2">
                  <label className="flex items-center gap-2"><input type="radio" name="cardsrc" checked={useSaved} onChange={() => setUseSaved(true)} />
                    Use my saved card {saved.masked.slice(-4) ? `ending ${saved.masked.slice(-4)}` : ""} (Visa Token Management Service)</label>
                  <label className="flex items-center gap-2"><input type="radio" name="cardsrc" checked={!useSaved} onChange={() => setUseSaved(false)} />
                    Enter a card</label>
                  <button type="button" onClick={forgetSaved} className="justify-self-start underline text-xs">Forget the saved card on this device</button>
                </div>
              )}
              {(!saved || !useSaved) && <CardFields onState={setCard} />}
              {(!saved || !useSaved) && (
                <label className="mt-2 flex items-center gap-2 text-sm font-bold">
                  <input type="checkbox" checked={saveCard} onChange={(e) => setSaveCard(e.target.checked)} />
                  Save this card with Visa for next time (the card stays in Visa&apos;s vault; this browser keeps a signed token)
                </label>
              )}
              <div className="mt-4 flex flex-wrap gap-3">
                <SquashButton onClick={startDeal} disabled={!!busy || (!(saved && useSaved) && card.state === "loading")} accent="var(--amber)">Agree and hold the payment</SquashButton>
                <SquashButton onClick={() => agentBuy(false)} disabled={!!busy} bg="var(--visa)" accent="var(--aqua)">Let our agent buy it</SquashButton>
              </div>
              <button type="button" onClick={() => agentBuy(true)} disabled={!!busy} className="mt-3 text-sm font-bold underline decoration-2 underline-offset-4">
                Try a tampered agent request (amount edited after signing)
              </button>
              <p className="mt-3 text-xs font-semibold text-ink/60">Authorizes with capture off. The agent path uses Visa&apos;s sandbox test card.</p>
            </>
          )}
          {visaLive && deal && (
            <>
              <p className="display text-5xl mt-1">{deal.status}</p>
              <p className="mt-1 display text-2xl">${deal.amountUsd.toFixed(2)}</p>
              {deal.promotion && (
                <p className="mt-1 rounded-xl border-2 border-ink bg-paper text-ink px-3 py-2 text-sm font-bold">
                  Visa card offer applied: {deal.promotion.description} (saved ${deal.promotion.discountUsd.toFixed(2)}{deal.askedUsd ? ` of $${deal.askedUsd.toFixed(2)}` : ""}). {deal.promotion.receipt}
                </p>
              )}
              <p className="mt-1 font-semibold opacity-80">{deal.listing}</p>
              <dl className="mt-3 text-xs font-mono grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 opacity-90">
                <dt>authorization</dt><dd className="break-all">{deal.authId}</dd>
                {deal.card && <><dt>card</dt><dd>{deal.card === "microform" ? "entered in Visa Microform (tokenized)" : deal.card === "saved-card" ? "saved card (Visa Token Management Service)" : "Visa sandbox test card"}</dd></>}
                {deal.settlementId && (deal.status === "CAPTURED" || deal.status === "REVERSED") && (<><dt>{deal.status === "CAPTURED" ? "capture" : "reversal"}</dt><dd className="break-all">{deal.settlementId}</dd></>)}
                <dt>deal</dt><dd className="break-all">{deal.dealId}</dd>
                {deal.passportPath && <><dt>passport</dt><dd><a href={deal.passportPath} className="underline font-bold">Solana devnet record</a></dd></>}
                {deal.passportError && <><dt>passport</dt><dd>{deal.passportError}</dd></>}
              </dl>
              {deal.status === "CAPTURED" && deal.token && <WatchThisItem token={deal.token} />}
              {health?.integrations?.mongo && (
                <div className="mt-4 flex items-center gap-3 rounded-2xl border-2 border-ink bg-paper text-ink p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/qr?deal=${deal.dealId}`} alt="QR code for the seller's live view of this deal" className="w-24 h-24" />
                  <p className="text-sm font-bold">Seller: scan to watch this deal live on your phone, and see why it settles the way it does.
                    <a href={`/deal/${deal.dealId}`} className="block underline mt-1">open the seller view</a></p>
                </div>
              )}
              {deal.status === "REFUSED" && <p className="mt-3 font-semibold">Visa refused to settle ({deal.reason ?? "no reason given"}){deal.reason === "MISSING_AUTH" ? ": this hold was already settled or is not open" : ""}. Visa did not apply it.</p>}
              {deal.status === "UNKNOWN" && <p className="mt-3 font-semibold">Visa did not answer. The settlement may have landed: do not retry; check the Visa Business Center.</p>}
              {deal.status === "HELD"
                ? <p className="mt-3 font-semibold">Held at Visa. Scan the label: the check decides capture or reversal.
                    <a href="/checkpoint" className="block mt-1 underline font-bold">Or settle it at the table kiosk with a barcode scanner</a></p>
                : <button type="button" onClick={() => { saveDeal(null); setVerdict(null); }} className="mt-4 rounded-full border-2 border-current px-4 py-2 font-extrabold">
                    {deal.status === "UNKNOWN" ? "I checked the Visa Business Center: start a new deal" : "Start a new deal"}
                  </button>}
            </>
          )}
          {agentMsg && (
            <div className={`mt-3 rounded-xl p-3 text-sm font-semibold ${agentMsg.ok ? "bg-paper text-green-deep" : "bg-paper text-red-deep"}`}>
              <p>{agentMsg.ok ? "TAP verified. " : "TAP refused. "}{agentMsg.text}</p>
              {agentMsg.sig && <p className="mt-1 font-mono text-[0.65rem] break-all text-ink/60">Signature-Input: {agentMsg.sig}</p>}
            </div>
          )}
          {dealErr && <p className="mt-3 rounded-xl bg-paper text-red-deep p-3 font-bold">{dealErr}</p>}
        </div>
        {cls && (
          <div className="rounded-[2rem] bg-aqua-soft border-[3px] border-ink p-6">
            <p className="text-sm font-extrabold tracking-wider">ON-DEVICE MODEL</p>
            <p className="display text-3xl mt-1">{CLASS_NAME[cls.cls]} · {(cls.p * 100).toFixed(0)}%</p>
            <p className="mt-2 text-sm font-semibold text-ink/70">Ran in this browser. A guess under 60% never bans anything.</p>
          </div>
        )}
        {look && (
          <div className="rounded-[2rem] bg-paper border-[3px] border-ink p-6">
            <p className="text-sm font-extrabold tracking-wider">CLOSEST CPSC RECALL PHOTOS · MONGODB ATLAS VECTOR SEARCH</p>
            {"error" in look ? <p className="mt-2 font-semibold">{look.error}</p> : (
              <ul className="mt-3 grid gap-3">
                {look.matches.map((m) => (
                  <li key={m.recallNumber} className="grid grid-cols-[4.5rem_1fr] gap-3 items-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={/^https:\/\/(www\.)?cpsc\.gov\//.test(m.image) ? m.image : ""} alt={`CPSC recall ${m.recallNumber} photo`} loading="lazy" referrerPolicy="no-referrer"
                      className="w-[4.5rem] h-[4.5rem] object-cover rounded-xl border-2 border-ink bg-white" />
                    <div className="min-w-0">
                      <p className="font-extrabold leading-tight line-clamp-2">{m.title}</p>
                      <p className="text-sm font-semibold">
                        {m.strong ? <b>Very similar photo: compare your label with </b> : "Looks somewhat like "}
                        <a href={m.notice.startsWith("https://") ? m.notice : "https://www.cpsc.gov/Recalls"} target="_blank" rel="noreferrer" className="underline">CPSC {m.recallNumber}</a> · similarity score {m.cosine.toFixed(2)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs font-semibold text-ink/60">Searched the CPSC recall photos in our index with the embedding this browser computed. Tested on held-out photos, the right recall came back first a bit under half the time, and even very similar photos are sometimes a different product. Looking alike is a reason to read the label closely, never a verdict: only the label check moves money.</p>
          </div>
        )}
        {verdict && (
          <div ref={decisionRef} className={`rounded-[2rem] border-[3px] border-ink p-7 ${capture ? "bg-green text-paper" : reverse ? "bg-red text-paper" : "bg-amber-soft"}`}>
            <p className="text-sm font-extrabold tracking-wider opacity-80">DECISION · {verdict.kind}</p>
            <p className="display text-6xl mt-2">{capture ? "CAPTURE" : reverse ? "REVERSE" : "KEEP HELD"}</p>
            <p className="mt-2 font-bold">{VERDICT_LABEL[verdict.kind]}</p>
            <p className="mt-3 text-lg font-semibold">{verdict.reason}</p>
            {verdict.recall && (
              <a href={verdict.recall.url} target="_blank" rel="noreferrer" className="inline-block mt-4 font-extrabold underline decoration-2 underline-offset-4">
                CPSC {verdict.recall.recallNumber}: read the notice ↗
              </a>
            )}
            <SpeakVerdict kind={verdict.kind} autoPlay dark={!!(capture || reverse)} />
          </div>
        )}
      </div>
    </div>
  );
}
