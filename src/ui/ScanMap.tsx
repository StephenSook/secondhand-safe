"use client";

import { useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";

type Pt = { lat: number; lng: number; title: string; price: number | null; url: string; cls: string; p: number; flagged: boolean;
  review: { ok: string; note: string; round: string } | null };

const NAME: Record<string, string> = { inclined_or_inbed_sleeper: "infant sleeper", crib_bumper: "crib bumper", drop_side_crib: "drop-side crib", other: "no banned type" };

/** Every real Atlanta listing we scanned, on an OpenFreeMap basemap (no API key). Colors = what review found. */
export function ScanMap() {
  const box = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<{ count: number; reviewed: number; source: string } | null>(null);
  const [sel, setSel] = useState<Pt | null>(null);

  useEffect(() => {
    let map: import("maplibre-gl").Map | undefined;
    let cancelled = false;
    (async () => {
      const [maplibregl, data] = await Promise.all([
        import("maplibre-gl"),
        fetch("/data/atlanta-scan.json").then((r) => r.json() as Promise<{ count: number; source: string; points: Pt[] }>),
      ]);
      if (cancelled || !box.current) return;
      setInfo({ count: data.count, reviewed: data.points.filter((p) => p.review).length, source: data.source });
      maplibregl.setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");
      const m = new maplibregl.Map({
        container: box.current, style: "https://tiles.openfreemap.org/styles/positron",
        center: [-84.39, 33.77], zoom: 9.2, attributionControl: { compact: true },
      });
      map = m;
      m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      m.on("load", () => {
        m.addSource("scan", {
          type: "geojson",
          data: { type: "FeatureCollection", features: data.points.map((p, i) => ({ type: "Feature", id: i,
            geometry: { type: "Point", coordinates: [p.lng, p.lat] },
            properties: { i, state: p.review ? (p.review.ok === "yes" ? "real" : p.review.ok === "unsure" ? "unsure" : "false") : "clear" } })) },
        });
        m.addLayer({ id: "scan", type: "circle", source: "scan", paint: {
          "circle-radius": ["match", ["get", "state"], "clear", 4.5, 9],
          "circle-color": ["match", ["get", "state"], "real", "#e5484d", "unsure", "#ffb020", "false", "#9fe3e0", "#14163a"],
          "circle-stroke-color": "#fff8ec", "circle-stroke-width": 1.5, "circle-opacity": 0.85 } });
        m.on("click", "scan", (e) => { const f = e.features?.[0]; if (f) setSel(data.points[Number(f.properties?.i)]); });
        m.on("mouseenter", "scan", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "scan", () => { m.getCanvas().style.cursor = ""; });
      });
    })();
    return () => { cancelled = true; map?.remove(); };
  }, []);

  return (
    <div className="grid lg:grid-cols-[1fr_22rem] gap-6">
      <div ref={box} className="h-[70svh] min-h-[26rem] rounded-[2rem] border-[3px] border-ink overflow-hidden bg-sand" role="region" aria-label="Map of scanned Atlanta listings" />
      <aside className="rounded-[2rem] border-[3px] border-ink bg-paper p-6">
        {info && (
          <>
            <p className="display text-5xl">{info.count}</p>
            <p className="font-bold">real Atlanta listings scanned</p>
            <p className="mt-1 text-sm text-ink/60">{info.source}. Locations rounded to about 1 km.</p>
            <p className="mt-4 font-semibold">{info.reviewed} of them was ever flagged by the model, and review found it was a false alarm. That is the point: on Craigslist the obvious banned items are rare. The danger is what nobody reads at the handoff.</p>
          </>
        )}
        <ul className="mt-5 space-y-2 text-sm font-bold">
          <li className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-ink" /> scanned, no flag</li>
          <li className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-aqua" /> flagged, review: false alarm</li>
          <li className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-amber" /> flagged, review: unsure</li>
          <li className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-red" /> flagged, review: confirmed</li>
        </ul>
        {sel && (
          <div className="mt-6 rounded-2xl bg-sand border-2 border-ink p-4 text-sm">
            <p className="font-extrabold">{sel.title}</p>
            {sel.price != null && <p className="mt-1">${sel.price}</p>}
            <p className="mt-1">Model sees: {NAME[sel.cls]} ({Math.round(sel.p * 100)}%)</p>
            {sel.review && <p className="mt-1">Review (round {sel.review.round}): {sel.review.note || sel.review.ok}</p>}
            <a href={sel.url} target="_blank" rel="noreferrer" className="inline-block mt-2 underline font-bold">Open the listing ↗</a>
          </div>
        )}
      </aside>
    </div>
  );
}
