import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyHead, type ClipHead } from "@/core/clipHead";
import { embedImage } from "@/ml/clipEmbed";

/**
 * PLAN 2.8 parity. The head is trained on transformers.js q8 embeddings (the runtime phones run), so:
 *  1. head math: JS applyHead on the stored embedding equals sklearn's predict_proba to 1e-5;
 *  2. runtime: embedding the fixture photo on THIS machine lands close to the stored embedding and gives the
 *     reviewed label with a close probability. q8 kernels are not bit-identical across platforms: measured
 *     cosine 0.987 to 0.996 between Linux x64 CI and the macOS arm64 machine that trained the head (a phone's
 *     WebAssembly runtime is a third platform), so the bar is agreement on the decision, not identical bits.
 */
const dir = path.join(__dirname, "..", "fixtures", "classifier");
const py = JSON.parse(fs.readFileSync(path.join(dir, "python.json"), "utf8")) as {
  fixtures: { file: string; label: string; probs: number[]; logits: number[] }[];
};
const stored = JSON.parse(fs.readFileSync(path.join(dir, "js_q8_embeddings.json"), "utf8")) as Record<string, number[]>;
const head = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "public", "models", "head.json"), "utf8")) as ClipHead;

const cos = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return d / Math.sqrt(na * nb);
};

describe("classifier parity", () => {
  it.each(py.fixtures.map((f) => [f.file, f] as const))("head math matches sklearn: %s", (_n, fx) => {
    const r = applyHead(head, stored[fx.file]);
    const maxDp = Math.max(...head.classes.map((c, i) => Math.abs(r.probs[c] - fx.probs[i])));
    expect(maxDp).toBeLessThan(1e-5);
  });

  it.each(py.fixtures.map((f) => [f.file, f] as const))("runtime reproduces the embedding and class: %s", async (_n, fx) => {
    const e = await embedImage(path.join(dir, fx.file), "q8");
    const c = cos(e, stored[fx.file]);
    const r = applyHead(head, e);
    console.log(`${fx.file} cos=${c.toFixed(6)} cls=${r.cls} p=${r.p.toFixed(4)} label=${fx.label}`);
    expect(c).toBeGreaterThan(0.98);
    expect(r.cls).toBe(fx.label);
    expect(Math.abs(r.p - Math.max(...fx.probs))).toBeLessThan(0.15);
  }, 180_000);
});
