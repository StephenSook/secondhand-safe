"use client";

import { useEffect, useRef, useState } from "react";
import type { VerdictKind } from "@/core/verdict";

/** Plays the ElevenLabs spoken verdict. autoPlay tries once (browsers may block it); the button always works. */
export function SpeakVerdict({ kind, autoPlay = false, dark = false }: { kind: VerdictKind; autoPlay?: boolean; dark?: boolean }) {
  const [lang, setLang] = useState<"en" | "es">("en");
  const [state, setState] = useState<"idle" | "loading" | "playing" | "off">("idle");
  const audio = useRef<HTMLAudioElement | null>(null);

  async function play(l = lang) {
    setState("loading");
    try {
      const r = await fetch(`/api/voice?kind=${kind}&lang=${l}`);
      if (r.status === 503) { setState("off"); return; }
      if (!r.ok) throw new Error(String(r.status));
      const url = URL.createObjectURL(await r.blob());
      audio.current?.pause();
      audio.current = new Audio(url);
      audio.current.onended = () => setState("idle");
      await audio.current.play();
      setState("playing");
    } catch {
      setState("idle");
    }
  }

  useEffect(() => {
    // deferred so the effect itself never sets state (react-hooks/set-state-in-effect)
    const t = autoPlay ? window.setTimeout(() => void play("en"), 0) : undefined;
    return () => { window.clearTimeout(t); audio.current?.pause(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  if (state === "off") return null;
  const base = dark ? "border-paper text-paper" : "border-ink text-ink";
  return (
    <div className="mt-4 flex items-center gap-2">
      <button type="button" onClick={() => play()} className={`rounded-full border-2 px-4 py-2 font-extrabold ${base} hover:-rotate-1 transition-transform`}
        aria-label="Hear the verdict">
        {state === "loading" ? "…" : state === "playing" ? "Playing" : "Hear it"} 🔊
      </button>
      {(["en", "es"] as const).map((l) => (
        <button key={l} type="button" onClick={() => { setLang(l); play(l); }}
          className={`rounded-full border-2 px-3 py-2 text-sm font-extrabold uppercase ${base} ${lang === l ? "opacity-100" : "opacity-50"}`}
          aria-pressed={lang === l}>
          {l}
        </button>
      ))}
    </div>
  );
}
