/**
 * Keyboard-wedge barcode input. A USB barcode scanner is a keyboard: it types the digits of the code a few
 * milliseconds apart, then presses Enter. A person typing the same digits by hand is slower, and that must work
 * too (a judge without a scanner). So Enter submits what was typed; the timing only tells the two apart.
 *
 * Every code must carry a valid GTIN check digit (EAN-8, UPC-A, EAN-13, GTIN-14), because the check below it
 * moves money: a corrupted recalled UPC that no longer matches the recall index would read as NO_MATCH and
 * capture. Enter submits the WHOLE buffer since the last Enter, never a part of it: a valid suffix of a recalled
 * code can be a different, clean barcode (04871507 inside 698904871507), so a stray key, a pause or a split scan
 * makes the whole code invalid and nothing is sent. A rejected scan costs one rescan.
 */

export type WedgeResult =
  | { kind: "scan"; upc: string; source: "scanner" | "keyboard" }
  | { kind: "reject"; reason: string };

export interface WedgeOptions {
  /** A gap shorter than this between two keys is scanner speed (only labels the source; never picks digits). */
  maxGapMs?: number;
}

/** The GTIN lengths a retail barcode can have: EAN-8, UPC-A, EAN-13, GTIN-14. */
const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/** GS1 mod-10 check digit: weights 3 and 1 alternating from the digit next to the check digit. */
export function gtinValid(code: string): boolean {
  if (!/^\d+$/.test(code) || !GTIN_LENGTHS.has(code.length)) return false;
  return gtinCheckDigit(code.slice(0, -1)) === Number(code.at(-1));
}

/** The GS1 check digit for a GTIN body (every digit but the check digit). */
export function gtinCheckDigit(body: string): number {
  const sum = body.split("").map(Number).reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}

/** Digits only, then a valid GTIN or a reason. The rule a typed or pasted value goes through. */
export function normalizeUpc(raw: string): { ok: true; upc: string } | { ok: false; reason: string } {
  const upc = raw.replace(/\D/g, "");
  if (!GTIN_LENGTHS.has(upc.length)) {
    return { ok: false, reason: `Not a valid barcode: a UPC or EAN has 8, 12, 13 or 14 digits, and this has ${upc.length}.` };
  }
  if (!gtinValid(upc)) return { ok: false, reason: `Not a valid barcode: ${upc} fails its check digit. Scan or type it again.` };
  return { ok: true, upc };
}

export class WedgeBuffer {
  private chars: string[] = [];
  private times: number[] = [];
  private readonly maxGapMs: number;

  constructor(o: WedgeOptions = {}) {
    this.maxGapMs = o.maxGapMs ?? 50;
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
    this.chars.push(key);
    this.times.push(t);
    return null;
  }

  private finish(): WedgeResult | null {
    const code = this.chars.join("");
    const times = this.times;
    this.reset();
    if (!code) return null;
    const n = normalizeUpc(code);
    if (!n.ok) return { kind: "reject", reason: `Scan did not read cleanly, scan again. ${n.reason} Nothing was sent.` };
    const fast = times.every((t, i) => i === 0 || (Number.isFinite(t) && t - times[i - 1] < this.maxGapMs));
    return { kind: "scan", upc: n.upc, source: fast ? "scanner" : "keyboard" };
  }
}
