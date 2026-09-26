"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Visa Acceptance Microform card entry (PLAN 3.9). The number and CVV fields are iframes served by Visa; typing
 * into them never touches our page's JavaScript or our server. createToken() returns a transient token JWT that
 * /api/checkout sends to Visa in place of a card.
 */
type Field = { load: (sel: string) => void; on: (ev: string, cb: (d: { empty?: boolean; valid?: boolean; card?: { name: string }[] }) => void) => void };
type Micro = { createField: (t: string, o: object) => Field; createToken: (o: object, cb: (err: { message?: string } | null, token: string) => void) => void };
type FlexCtor = new (ctx: string) => { microform: (o: object) => Micro };
declare global { interface Window { Flex?: FlexCtor } }

export type Tokenize = () => Promise<string>;

function loadLibrary(src: string, integrity: string): Promise<void> {
  if (window.Flex) return Promise.resolve();
  return new Promise((ok, bad) => {
    const s = document.createElement("script");
    s.src = src; s.integrity = integrity; s.crossOrigin = "anonymous"; s.async = true;
    s.onload = () => ok(); s.onerror = () => bad(new Error("Visa's card-field library did not load"));
    document.head.appendChild(s);
  });
}

export function CardFields({ onReady }: { onReady: (t: Tokenize | null) => void }) {
  const id = useId().replace(/:/g, "");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [msg, setMsg] = useState("");
  const [brand, setBrand] = useState("");
  const [exp, setExp] = useState({ m: "12", y: "2031" });
  const expRef = useRef(exp);
  const readyRef = useRef(onReady);
  useEffect(() => { expRef.current = exp; readyRef.current = onReady; });

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch("/api/microform", { method: "POST" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        const payload = JSON.parse(atob(j.captureContext.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        const lib = payload.ctx?.[0]?.data;
        if (!lib?.clientLibrary || !lib?.clientLibraryIntegrity) throw new Error("capture context has no client library");
        await loadLibrary(lib.clientLibrary, lib.clientLibraryIntegrity);
        if (dead || !window.Flex) return;
        const micro = new window.Flex(j.captureContext).microform({
          styles: { input: { "font-size": "18px", "font-family": "monospace", color: "#0b1d2a" }, ":focus": { color: "#0b1d2a" }, valid: { color: "#0a7a3b" }, invalid: { color: "#c62828" } },
        });
        const number = micro.createField("number", { placeholder: "4111 1111 1111 1111" });
        const cvv = micro.createField("securityCode", { placeholder: "CVV" });
        number.load(`#n-${id}`);
        cvv.load(`#c-${id}`);
        number.on("change", (d) => setBrand(d.card?.[0]?.name ?? ""));
        setState("ready");
        readyRef.current(() => new Promise<string>((ok, bad) => {
          const t = setTimeout(() => bad(new Error("Visa did not return a card token in 20 s")), 20_000);
          micro.createToken({ expirationMonth: expRef.current.m.padStart(2, "0"), expirationYear: expRef.current.y }, (err, token) => {
            clearTimeout(t);
            if (err) bad(new Error(err.message ?? "card could not be tokenized")); else ok(token);
          });
        }));
      } catch (e) {
        if (dead) return;
        setState("error");
        setMsg((e as Error).message);
        readyRef.current(null);
      }
    })();
    return () => { dead = true; };
  }, [id]);

  const box = "h-11 rounded-xl border-2 border-ink bg-paper px-3 pt-2.5";
  return (
    <fieldset className="mt-4 rounded-2xl border-2 border-ink bg-paper/70 p-3" aria-describedby={`h-${id}`}>
      <legend className="px-1 text-xs font-extrabold tracking-wider">CARD · VISA MICROFORM {brand && `· ${brand.toUpperCase()}`}</legend>
      <div className="grid grid-cols-[1fr_5.5rem] gap-2">
        <div><span className="text-xs font-bold">card number</span><div id={`n-${id}`} data-testid="mf-number" className={box} /></div>
        <div><span className="text-xs font-bold">CVV</span><div id={`c-${id}`} data-testid="mf-cvv" className={box} /></div>
      </div>
      <div className="mt-2 flex gap-2 items-end text-xs font-bold">
        <label className="grid">month<input aria-label="expiry month" inputMode="numeric" maxLength={2} value={exp.m} onChange={(e) => setExp({ ...exp, m: e.target.value.replace(/\D/g, "") })} className="w-14 h-9 rounded-lg border-2 border-ink px-2 font-mono" /></label>
        <label className="grid">year<input aria-label="expiry year" inputMode="numeric" maxLength={4} value={exp.y} onChange={(e) => setExp({ ...exp, y: e.target.value.replace(/\D/g, "") })} className="w-20 h-9 rounded-lg border-2 border-ink px-2 font-mono" /></label>
      </div>
      <p id={`h-${id}`} className="mt-2 text-xs font-semibold text-ink/60">
        {state === "loading" && "Loading Visa's secure card fields…"}
        {state === "ready" && "These two boxes are Visa's, not ours: the card number never reaches our server. Sandbox test card: 4111 1111 1111 1111."}
        {state === "error" && `Card fields unavailable (${msg}). The sandbox test card is used instead.`}
      </p>
    </fieldset>
  );
}
