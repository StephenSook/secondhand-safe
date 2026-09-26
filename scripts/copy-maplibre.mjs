// Serve MapLibre's module worker from our own origin (Turbopack cannot bundle it): copied at build time so
// the files always match the installed maplibre-gl version. /map calls setWorkerUrl on this path.
import fs from "node:fs";
const src = "node_modules/maplibre-gl/dist";
const dst = "public/vendor/maplibre";
fs.mkdirSync(dst, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) fs.copyFileSync(`${src}/${f}`, `${dst}/${f}`);
console.log("maplibre worker copied to", dst);
