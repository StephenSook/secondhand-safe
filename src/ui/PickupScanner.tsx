"use client";

import { useEffect, useRef, useState } from "react";
import type { Verdict } from "@/core/verdict";
import { VERDICT_LABEL, CAPTURABLE } from "@/core/verdict";
import type { ClipHead, ClassifyResult } from "@/core/clipHead";
import type { LabelRead } from "@/server/ml/label";
import { SquashButton } from "./SquashButton";
import { setupGsap, gsap, prefersReducedMotion } from "./motion/gsap";

type Health = { integrations: Record<string, boolean> };
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
  const [fields, setFields] = useState({ model: "", batch: "", upc: "", text: "" });
  const [label, setLabel] = useState<LabelRead | null>(null);
  const [labelMsg, setLabelMsg] = useState("");
  const [cls, setCls] = useState<ClassifyResult | null>(null);
  const [clsMsg, setClsMsg] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [busy, setBusy] = useState("");
  const decisionRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
  }, []);

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
      const r = applyHead(head, await embedImage(file, "q8"));
      setCls(r);
      setClsMsg("");
      return r;
    } catch (e) {
      setClsMsg(`The on-device model could not run here (${(e as Error).message}). The label check still works.`);
      return null;
    }
  }

  async function onPhoto(file: File) {
    setVerdict(null);
    setLabel(null);
    setCls(null);
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

  async function check(f = fields, c = cls) {
    setBusy("Checking recalls…");
    const r = await fetch("/api/check", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...f, cls: c ? { cls: c.cls, p: c.p } : undefined }),
    });
    const j = (await r.json()) as { verdict: Verdict };
    setVerdict(j.verdict);
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
          <SquashButton onClick={() => inputRef.current?.click()} accent="var(--amber)">{photo ? "Retake photo" : "Take the label photo"}</SquashButton>
          {busy && <span className="font-bold text-ink/70" role="status">{busy}</span>}
        </div>
        {labelMsg && <p className="mt-4 rounded-xl bg-amber-soft p-3 font-semibold">{labelMsg}</p>}
        {clsMsg && <p className="mt-3 rounded-xl bg-aqua-soft p-3 font-semibold">{clsMsg}</p>}
        <form className="mt-6 grid sm:grid-cols-3 gap-3" onSubmit={(e) => { e.preventDefault(); check(); }}>
          {(["model", "batch", "upc"] as const).map((k) => (
            <label key={k} className="block text-sm font-bold capitalize">{k === "upc" ? "UPC" : k}
              <input value={fields[k]} onChange={(e) => setFields({ ...fields, [k]: e.target.value })} autoComplete="off"
                inputMode={k === "upc" ? "numeric" : "text"}
                className="mt-1 w-full rounded-xl border-2 border-ink px-3 py-2.5 font-mono uppercase focus:outline-none focus:ring-4 focus:ring-amber" />
            </label>
          ))}
          <div className="sm:col-span-3"><SquashButton type="submit" accent="var(--green)">Check what the label says</SquashButton></div>
        </form>
      </div>

      <div aria-live="polite" className="grid gap-5">
        <div className={`rounded-[2rem] border-[3px] border-ink p-6 ${visaLive ? "bg-amber" : "bg-sand"}`}>
          <p className="text-sm font-extrabold tracking-wider">PAYMENT</p>
          <p className="display text-4xl mt-1">{visaLive ? "HELD" : "Visa hold not connected here"}</p>
          <p className="mt-2 font-semibold text-ink/80">
            {visaLive ? "The buyer's Visa authorization is held until this check decides." : "This deployment has no Visa sandbox keys yet, so the check below decides what would happen to the hold."}
          </p>
        </div>
        {cls && (
          <div className="rounded-[2rem] bg-aqua-soft border-[3px] border-ink p-6">
            <p className="text-sm font-extrabold tracking-wider">ON-DEVICE MODEL</p>
            <p className="display text-3xl mt-1">{CLASS_NAME[cls.cls]} · {(cls.p * 100).toFixed(0)}%</p>
            <p className="mt-2 text-sm font-semibold text-ink/70">Ran in this browser. A guess under 60% never bans anything.</p>
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
          </div>
        )}
      </div>
    </div>
  );
}
