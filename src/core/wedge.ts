/**
 * Keyboard-wedge barcode input. A USB barcode scanner is a keyboard: it types the digits of the code a few
 * milliseconds apart, then presses Enter. A person typing the same digits by hand is slower, and that must work
 * too (a judge without a scanner). So Enter submits what was typed; the timing only tells the two apart.
 *
 * Every code must carry a valid GTIN check digit (EAN-8, UPC-A, EAN-13, GTIN-14), because the check below it
 * moves money: a corrupted recalled UPC that no longer matches the recall index would read as NO_MATCH and
 * capture. A stray key pressed just before a scan (inside the scanner's timing) is caught the same way: the
 * burst fails its check digit while the code without that key passes, so only the valid code is used and the
 * stray key is reported. When both readings are valid barcodes, nothing is sent: the operator scans again.
 */

export type WedgeResult =
  | { kind: "scan"; upc: string; source: "scanner" | "keyboard"; strayIgnored?: string }
  | { kind: "reject"; reason: string };

export interface WedgeOptions {
  /** A gap shorter than this between two keys is scanner speed. */
  maxGapMs?: number;
  /** Digits older than this are forgotten when the next digit arrives (a stray key long ago). */
  idleResetMs?: number;
}

/** The GTIN lengths a retail barcode can have: EAN-8, UPC-A, EAN-13, GTIN-14. */
const GTIN_LENGTHS = new Set([8, 12, 13, 14]);
/** How many stray keys in front of a scan are considered. */
const MAX_STRAY = 2;

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

/** A scanner burst: the whole burst if it is a valid barcode, else the one valid code left after dropping a stray
 *  key or two in front of it; ambiguous or invalid bursts are rejected. */
function readBurst(burst: string): WedgeResult {
  const whole = gtinValid(burst);
  // a leading 0 is not a stray key: "0" + a UPC-A is that product's EAN-13
  const strays: number[] = [];
  for (let k = 1; k <= MAX_STRAY && burst.length - k >= 8; k++) {
    if (!/^0+$/.test(burst.slice(0, k)) && gtinValid(burst.slice(k))) strays.push(k);
  }
  if (whole && strays.length === 0) return { kind: "scan", upc: burst, source: "scanner" };
  if (!whole && strays.length === 1) {
    return { kind: "scan", upc: burst.slice(strays[0]), source: "scanner", strayIgnored: burst.slice(0, strays[0]) };
  }
  if (whole || strays.length > 1) {
    return { kind: "reject", reason: `Scanned ${burst}, which reads as more than one valid barcode (a key may have been pressed during the scan). Nothing was sent: scan again.` };
  }
  const n = normalizeUpc(burst);
  return { kind: "reject", reason: n.ok ? "Not a valid barcode." : n.reason };
}

export class WedgeBuffer {
  private chars: string[] = [];
  private times: number[] = [];
  private readonly maxGapMs: number;
  private readonly idleResetMs: number;

  constructor(o: WedgeOptions = {}) {
    this.maxGapMs = o.maxGapMs ?? 50;
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
    // the trailing run of keys that arrived at scanner speed; slower keys before it are not part of the scan
    let start = chars.length - 1;
    while (start > 0 && Number.isFinite(times[start - 1]) && times[start] - times[start - 1] < this.maxGapMs) start -= 1;
    const burst = chars.slice(start).join("");
    if (burst.length >= 8) return readBurst(burst);
    // typed by hand: exactly what was typed, and it must be a valid barcode (a typo is rejected, never repaired)
    const n = normalizeUpc(chars.join(""));
    return n.ok ? { kind: "scan", upc: n.upc, source: "keyboard" } : { kind: "reject", reason: n.reason };
  }
}
