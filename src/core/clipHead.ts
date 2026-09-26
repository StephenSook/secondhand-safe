import type { ProductClass } from "./verdict";

/** The trained logistic-regression head exported by ml/train.py to public/models/head.json. */
export interface ClipHead {
  model: string;
  classes: ProductClass[];
  coef: number[][];
  intercept: number[];
}

export interface ClassifyResult {
  cls: ProductClass;
  p: number;
  probs: Record<ProductClass, number>;
  logits: number[];
}

/** L2-normalize the CLIP image embedding, then softmax(coef . x + b), matching sklearn's multinomial head. */
export function applyHead(head: ClipHead, embedding: ArrayLike<number>): ClassifyResult {
  const x = Array.from(embedding);
  if (x.length !== head.coef[0].length) throw new Error(`embedding has ${x.length} dims, head expects ${head.coef[0].length}`);
  const norm = Math.hypot(...x) || 1;
  const xn = x.map((v) => v / norm);
  const logits = head.coef.map((w, k) => w.reduce((s, wi, i) => s + wi * xn[i], head.intercept[k]));
  const m = Math.max(...logits);
  const e = logits.map((l) => Math.exp(l - m));
  const z = e.reduce((a, b) => a + b, 0);
  const p = e.map((v) => v / z);
  const k = p.indexOf(Math.max(...p));
  return {
    cls: head.classes[k],
    p: p[k],
    probs: Object.fromEntries(head.classes.map((c, i) => [c, p[i]])) as Record<ProductClass, number>,
    logits,
  };
}
