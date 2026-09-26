/**
 * Keyboard-wedge barcode input. A USB barcode scanner is a keyboard: it types the digits of the code a few
 * milliseconds apart, then presses Enter. A person typing the same digits by hand is slower, and that must work
 * too (a judge without a scanner). So Enter always submits what was typed; the timing only tells the two apart,
 * and it drops stray digits typed before a scanner burst, so "1" pressed by accident and then a scan never
 * becomes a wrong UPC.
 */

export type WedgeResult =
  | { kind: "scan"; upc: string; source: "scanner" | "keyboard" }
  | { kind: "reject"; reason: string };

export interface WedgeOptions {
  /** A gap shorter than this between two keys is scanner speed. */
  maxGapMs?: number;
  /** UPC-E and EAN-8 have 8 digits; UPC-A 12, EAN-13 13, GTIN-14 14. */
  minDigits?: number;
  maxDigits?: number;
  /** Digits older than this are forgotten when the next digit arrives (a stray key long ago). */
  idleResetMs?: number;
}

/** Digits only, length checked. The one rule both the scanner path and a pasted or typed value go through. */
export function normalizeUpc(raw: string, minDigits = 8, maxDigits = 14): { ok: true; upc: string } | { ok: false; reason: string } {
  const upc = raw.replace(/\D/g, "");
  if (upc.length < minDigits) return { ok: false, reason: `A barcode has at least ${minDigits} digits; got ${upc.length}.` };
  if (upc.length > maxDigits) return { ok: false, reason: `A barcode has at most ${maxDigits} digits; got ${upc.length}.` };
  return { ok: true, upc };
}

export class WedgeBuffer {
  private chars: string[] = [];
  private times: number[] = [];
  private readonly maxGapMs: number;
  private readonly minDigits: number;
  private readonly maxDigits: number;
  private readonly idleResetMs: number;

  constructor(o: WedgeOptions = {}) {
    this.maxGapMs = o.maxGapMs ?? 50;
    this.minDigits = o.minDigits ?? 8;
    this.maxDigits = o.maxDigits ?? 14;
    this.idleResetMs = o.idleResetMs ?? 10_000;
  }

  get digits(): string {
    return this.chars.join("");
  }

  reset() {
    this.chars = [];
    this.times = [];
  }

  /** Replace the buffer with the digits of a pasted or soft-keyboard value. It counts as typed, never as a scan. */
  set(text: string) {
    this.chars = text.replace(/\D/g, "").split("");
    this.times = this.chars.map(() => Number.NEGATIVE_INFINITY);
  }

  /**
   * Feed one KeyboardEvent.key with its timestamp (ms). Digits are kept, Backspace removes one, Enter finishes,
   * everything else (letters, dashes, Shift, Tab) is ignored. Returns a result only on Enter with digits.
   */
  key(key: string, t: number): WedgeResult | null {
    if (key === "Enter") return this.finish();
    if (key === "Backspace") {
      this.chars.pop();
      this.times.pop();
      return null;
    }
    if (!/^\d$/.test(key)) return null;
    const last = this.times[this.times.length - 1];
    if (last !== undefined && Number.isFinite(last) && t - last > this.idleResetMs) this.reset();
    this.chars.push(key);
    this.times.push(t);
    return null;
  }

  private finish(): WedgeResult | null {
    const chars = this.chars;
    const times = this.times;
    this.reset();
    if (chars.length === 0) return null;
    // the trailing run of keys that arrived at scanner speed
    let start = chars.length - 1;
    while (start > 0 && Number.isFinite(times[start - 1]) && times[start] - times[start - 1] < this.maxGapMs) start -= 1;
    const burst = chars.slice(start).join("");
    const scanned = burst.length >= this.minDigits;
    const n = normalizeUpc(scanned ? burst : chars.join(""), this.minDigits, this.maxDigits);
    if (!n.ok) return { kind: "reject", reason: n.reason };
    return { kind: "scan", upc: n.upc, source: scanned ? "scanner" : "keyboard" };
  }
}
