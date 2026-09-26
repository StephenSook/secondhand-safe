"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type P = { x: number; y: number; img: string; src: string; title: string; url: string | null; label: string | null; pred: string; p: number };
const COLOR: Record<string, string> = {
  inclined_or_inbed_sleeper: "#e5484d", crib_bumper: "#ff5fa2", drop_side_crib: "#f08c00", other: "#0e6e6e",
};
const NAME: Record<string, string> = {
  inclined_or_inbed_sleeper: "Inclined / in-bed sleeper", crib_bumper: "Crib bumper", drop_side_crib: "Drop-side crib", other: "Everything else",
};

/** 2D map of the model's view: every image the model has seen, laid out by similarity (t-SNE). */
export function Atlas() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<{ method: string; count: number; labeled: number; points: P[] } | null>(null);
  const [hover, setHover] = useState<P | null>(null);
  const [only, setOnly] = useState<string | null>(null);

  useEffect(() => {
    fetch("/data/atlas.json").then((r) => r.json()).then(setData).catch(() => setData(null));
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    data?.points.forEach((p) => { if (p.label) c[p.label] = (c[p.label] ?? 0) + 1; });
    return c;
  }, [data]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !data) return;
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = c.clientWidth, h = c.clientHeight;
      c.width = w * dpr; c.height = h * dpr;
      const ctx = c.getContext("2d")!;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);
      const pad = 18;
      // unlabeled first (faint), labeled on top (strong)
      for (const pass of [false, true]) {
        for (const p of data.points) {
          if (!!p.label !== pass) continue;
          const cls = p.label ?? p.pred;
          if (only && cls !== only) continue;
          ctx.globalAlpha = p.label ? 0.95 : 0.28;
          ctx.fillStyle = COLOR[cls];
          ctx.beginPath();
          ctx.arc(pad + p.x * (w - 2 * pad), pad + p.y * (h - 2 * pad), p.label ? 4.2 : 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [data, only]);

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!data || !canvas.current) return;
    const r = canvas.current.getBoundingClientRect();
    const pad = 18, w = r.width, h = r.height;
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best: P | null = null, bd = 14 * 14;
    for (const p of data.points) {
      const cls = p.label ?? p.pred;
      if (only && cls !== only) continue;
      const dx = pad + p.x * (w - 2 * pad) - mx, dy = pad + p.y * (h - 2 * pad) - my;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = p; }
    }
    setHover(best);
  };

  return (
    <div className="grid lg:grid-cols-[1fr_20rem] gap-6">
      <div className="relative rounded-[2rem] border-[3px] border-ink bg-paper overflow-hidden">
        <canvas ref={canvas} onPointerMove={onMove} onPointerLeave={() => setHover(null)}
          className="w-full h-[70svh] min-h-[26rem] block cursor-crosshair" role="img"
          aria-label="Scatter plot of product photos arranged by visual similarity, colored by product type" />
        {!data && <p className="absolute inset-0 grid place-items-center hand text-3xl text-ink/50">loading the atlas…</p>}
      </div>
      <aside className="rounded-[2rem] border-[3px] border-ink bg-paper p-6">
        {data && <p className="text-sm font-semibold text-ink/60">{data.count} images · {data.labeled} reviewed labels (solid) · the rest show the model&apos;s guess (faint)</p>}
        <ul className="mt-4 space-y-2">
          {Object.keys(COLOR).map((k) => (
            <li key={k}>
              <button type="button" onClick={() => setOnly(only === k ? null : k)} aria-pressed={only === k}
                className={`w-full flex items-center gap-2 rounded-xl border-2 px-3 py-2 font-bold text-left ${only === k ? "border-ink bg-sand" : "border-transparent"}`}>
                <span className="w-3.5 h-3.5 rounded-full" style={{ background: COLOR[k] }} />
                <span className="flex-1">{NAME[k]}</span><span className="text-ink/50">{counts[k] ?? 0}</span>
              </button>
            </li>
          ))}
        </ul>
        {hover ? (
          <div className="mt-5 rounded-2xl bg-sand border-2 border-ink p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={hover.img} alt={hover.title || "product photo"} className="w-full h-40 object-contain bg-white rounded-lg" />
            <p className="mt-2 text-sm font-extrabold">{hover.title || "(recall photo)"}</p>
            <p className="text-xs font-semibold mt-1">{hover.src} · {hover.label ? `reviewed: ${NAME[hover.label]}` : "not reviewed"}</p>
            <p className="text-xs font-semibold">model: {NAME[hover.pred]} ({Math.round(hover.p * 100)}%)</p>
          </div>
        ) : (
          <p className="mt-5 hand text-2xl text-ink/60">point at a dot to see the photo</p>
        )}
        {data && <p className="mt-5 text-xs text-ink/50">{data.method}</p>}
      </aside>
    </div>
  );
}
