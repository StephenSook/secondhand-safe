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
/** loading: fields not ready (do not pay yet). ready: tokenize() seals the typed card. error: no fields, the
 *  sandbox test card is used and the deal says so. */
export type CardState = { state: "loading" } | { state: "ready"; tokenize: Tokenize } | { state: "error"; reason: string };

function loadLibrary(src: string, integrity: string): Promise<void> {
  if (window.Flex) return Promise.resolve();
  return new Promise((ok, bad) => {
    const s = document.createElement("script");
    s.src = src; s.integrity = integrity; s.crossOrigin = "anonymous"; s.async = true;
    s.onload = () => ok(); s.onerror = () => bad(new Error("Visa's card-field library did not load"));
    document.head.appendChild(s);
  });
}

export function CardFields({ onState }: { onState: (s: CardState) => void }) {
  const id = useId().replace(/[^\w-]/g, "");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [msg, setMsg] = useState("");
  const [brand, setBrand] = useState("");
  const [gen, setGen] = useState(0);
  const [exp, setExp] = useState({ m: "", y: "" });
  const expRef = useRef(exp);
  const stateRef = useRef(onState);
  useEffect(() => { expRef.current = exp; stateRef.current = onState; });

  useEffect(() => {
    let dead = false;
    stateRef.current({ state: "loading" });
    (async () => {
      try {
        const r = await fetch("/api/microform", { method: "POST", signal: AbortSignal.timeout(15_000) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        const payload = JSON.parse(atob(j.captureContext.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        const lib = payload.ctx?.[0]?.data;
        if (!lib?.clientLibrary || !lib?.clientLibraryIntegrity) throw new Error("capture context has no client library");
        // lifetime from Visa's own iat/exp, counted on this device's clock, so a skewed device clock cannot
        // make fresh fields look expired
        const expiresMs = Date.now() + (Number(payload.exp) - Number(payload.iat)) * 1000;
        await loadLibrary(lib.clientLibrary, lib.clientLibraryIntegrity);
        if (dead) return;
        if (!window.Flex) throw new Error("Visa's card-field library did not start");
        const micro = new window.Flex(j.captureContext).microform({
          styles: { input: { "font-size": "18px", "font-family": "monospace", color: "#0b1d2a" }, ":focus": { color: "#0b1d2a" }, valid: { color: "#0a7a3b" }, invalid: { color: "#c62828" } },
        });
        const number = micro.createField("number", { placeholder: "4111 1111 1111 1111" });
        const cvv = micro.createField("securityCode", { placeholder: "CVV" });
        for (const k of ["n", "c"]) document.getElementById(`${k}-${id}`)?.replaceChildren(); // fresh fields after an expiry reload
        number.load(`#n-${id}`);
        cvv.load(`#c-${id}`);
        number.on("change", (d) => setBrand(d.card?.[0]?.name ?? ""));
        setState("ready");
        const tokenize: Tokenize = () => new Promise<string>((ok, bad) => {
          if (dead) return bad(new Error("card fields were closed; try again"));
          // Visa's capture context is short-lived: past its expiry every token fails, so fetch fresh fields
          if (Number.isFinite(expiresMs) && Date.now() > expiresMs - 30_000) {
            setState("loading");
            setGen((g) => g + 1);
            return bad(new Error("The card fields expired. They have been reloaded: type the card again."));
          }
          const { m, y } = expRef.current;
          const month = Number(m), year = Number(y), now = new Date();
          if (!/^\d{1,2}$/.test(m) || month < 1 || month > 12 || !/^\d{4}$/.test(y)
            || year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) {
            return bad(new Error("Enter the card's expiry month (1-12) and 4-digit year."));
          }
          const t = setTimeout(() => bad(new Error("Visa did not return a card token in 20 s")), 20_000);
          micro.createToken({ expirationMonth: m.padStart(2, "0"), expirationYear: y }, (err, token) => {
            clearTimeout(t);
            if (err) bad(new Error(err.message ?? "card could not be tokenized")); else ok(token);
          });
        });
        stateRef.current({ state: "ready", tokenize });
      } catch (e) {
        if (dead) return;
        setState("error");
        setMsg((e as Error).message);
        stateRef.current({ state: "error", reason: (e as Error).message });
      }
    })();
    return () => { dead = true; stateRef.current({ state: "loading" }); };
  }, [id, gen]);

  const box = "h-11 rounded-xl border-2 border-ink bg-paper px-3 pt-2.5";
  return (
    <fieldset className="mt-4 rounded-2xl border-2 border-ink bg-paper/70 p-3" aria-describedby={`h-${id}`}>
      <legend className="px-1 text-xs font-extrabold tracking-wider">CARD · VISA MICROFORM {brand && `· ${brand.toUpperCase()}`}</legend>
      <div className="grid grid-cols-[1fr_5.5rem] gap-2">
        <div><span className="text-xs font-bold">card number</span><div id={`n-${id}`} data-testid="mf-number" className={box} /></div>
        <div><span className="text-xs font-bold">CVV</span><div id={`c-${id}`} data-testid="mf-cvv" className={box} /></div>
      </div>
      <div className="mt-2 flex gap-2 items-end text-xs font-bold">
        <label className="grid">month<input aria-label="expiry month" inputMode="numeric" maxLength={2} placeholder="12" value={exp.m} onChange={(e) => setExp({ ...exp, m: e.target.value.replace(/\D/g, "") })} className="w-14 h-9 rounded-lg border-2 border-ink px-2 font-mono" /></label>
        <label className="grid">year<input aria-label="expiry year" inputMode="numeric" maxLength={4} placeholder="2031" value={exp.y} onChange={(e) => setExp({ ...exp, y: e.target.value.replace(/\D/g, "") })} className="w-20 h-9 rounded-lg border-2 border-ink px-2 font-mono" /></label>
      </div>
      <p id={`h-${id}`} className="mt-2 text-xs font-semibold text-ink/60">
        {state === "loading" && "Loading Visa's secure card fields…"}
        {state === "ready" && "These two boxes are Visa's, not ours: the card number never reaches our server. Sandbox test card: 4111 1111 1111 1111."}
        {state === "error" && `Card fields unavailable (${msg}). The sandbox test card is used instead.`}
      </p>
    </fieldset>
  );
}
