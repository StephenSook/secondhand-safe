import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openHold, explicitlyNoHold, markPending, clearPending, readBoth, shownHold } from "@/ui/holdGuard";

// openHold(raw) reads "<shs-deal JSON>\n<shs-pending JSON>" (what the shop page reads from sessionStorage).
const deal = (o: object) => JSON.stringify(o);

describe("one open hold at a time, across reloads and lost answers", () => {
  it("an open HELD or UNKNOWN deal blocks a second hold", () => {
    for (const status of ["HELD", "UNKNOWN"]) {
      const h = openHold(`${deal({ dealId: "shs-1", listingId: "ebay:1", listing: "Bassinet", amountUsd: 64, status })}\n`);
      expect(h).toMatchObject({ id: "ebay:1", handoff: true });
    }
  });
  it("a pending marker (Visa never answered clearly) blocks too, and says a hold MAY exist", () => {
    const h = openHold(`\n${deal({ listingId: "ebay:2", listing: "Crib", amountUsd: 90 })}`);
    expect(h).toMatchObject({ id: "ebay:2", pending: true, handoff: false });
    expect(h?.text).toMatch(/MAY exist/);
  });
  it("a settled deal and no marker leave the page free", () => {
    for (const status of ["CAPTURED", "REVERSED", "REFUSED"]) expect(openHold(`${deal({ dealId: "shs-1", listingId: "x", status })}\n`)).toBeNull();
    expect(openHold("\n")).toBeNull();
  });
  it("corrupt storage never throws and never invents a hold", () => {
    expect(openHold("{not json\n{also not")).toBeNull();
    expect(openHold(`${deal({ status: "HELD" })}\n`)).toBeNull(); // no dealId: not a hold we can name
  });
});

describe("only an explicit 'no hold placed' clears the pending marker", () => {
  it("reads placed:false from /api/checkout and from the agent wrapper's merchant", () => {
    expect(explicitlyNoHold({ placed: false, error: "x" })).toBe(true);
    expect(explicitlyNoHold({ merchant: { placed: false, httpStatus: 401 } })).toBe(true);
  });
  it("anything else keeps it: uncertain, missing flags, a wrapper refusal without the flag, junk", () => {
    expect(explicitlyNoHold({ uncertain: true, error: "x" })).toBe(false);
    expect(explicitlyNoHold({ error: "HTTP 500" })).toBe(false);
    expect(explicitlyNoHold({ merchant: { uncertain: true } })).toBe(false);
    expect(explicitlyNoHold({ merchant: {}, placed: false })).toBe(false); // the merchant's answer wins
    expect(explicitlyNoHold(null)).toBe(false);
  });
});

describe("the guard never blocks forever and never invents a purchase", () => {
  it("a hold keeps blocking past 12 h (Visa may still hold it) and stops only after the sweeper's 48 h release window", () => {
    const mid = new Date(Date.now() - 13 * 3_600_000).toISOString();
    expect(openHold(`${JSON.stringify({ dealId: "shs-1", listingId: "x", status: "HELD", at: mid })}\n`)).not.toBeNull();
    const old = new Date(Date.now() - 49 * 3_600_000).toISOString();
    const fresh = new Date().toISOString();
    expect(openHold(`${JSON.stringify({ dealId: "shs-1", listingId: "x", status: "HELD", at: old })}\n`)).toBeNull();
    expect(openHold(`\n${JSON.stringify({ listingId: "x", at: old })}`)).toBeNull();
    expect(openHold(`${JSON.stringify({ dealId: "shs-1", listingId: "x", status: "HELD", at: fresh })}\n`)).not.toBeNull();
  });
});

describe("the MAY-exist warning is shown only when no request of this tab is in flight", () => {
  // the page's sessionStorage, stubbed so the real markPending / clearPending / readBoth run
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const attempt = { listingId: "table:0", listing: "Bassinet", amountUsd: 64 };

  it("(a) during this tab's in-flight request: the marker still blocks, but no warning is rendered", () => {
    expect(markPending(attempt)).toBe(true);
    const h = openHold(readBoth());
    expect(h).toMatchObject({ id: "table:0", pending: true }); // blocking is unchanged: a second hold is refused
    expect(shownHold(h, true)).toBeNull(); // nothing to warn about yet: the caller shows its busy text
  });
  it("(b) a marker found on load (after a reload, nothing in flight) renders the warning", () => {
    expect(markPending(attempt)).toBe(true); // written by the tab before it reloaded mid-request
    const shown = shownHold(openHold(readBoth()), false);
    expect(shown).toMatchObject({ pending: true });
    expect(shown?.text).toMatch(/did not confirm.*MAY exist/);
  });
  it("(c) a failed or ambiguous answer keeps the marker and renders the warning once the request settles", () => {
    expect(markPending(attempt)).toBe(true);
    if (explicitlyNoHold({ error: "HTTP 504" })) clearPending(); // what the pages do in finally: not explicit, so kept
    const shown = shownHold(openHold(readBoth()), false);
    expect(shown?.text).toMatch(/MAY exist/);
  });
  it("an explicit placed:false clears the marker, so nothing is shown or blocked", () => {
    expect(markPending(attempt)).toBe(true);
    if (explicitlyNoHold({ placed: false, error: "declined" })) clearPending();
    expect(openHold(readBoth())).toBeNull();
  });
  it("a confirmed hold is always shown, in flight or not", () => {
    const h = openHold(`${deal({ dealId: "shs-1", listingId: "ebay:1", listing: "Bassinet", amountUsd: 64, status: "HELD" })}\n`);
    expect(shownHold(h, true)).toBe(h);
    expect(shownHold(h, false)).toBe(h);
    expect(shownHold(null, true)).toBeNull();
  });
});

describe("an unconfirmed settlement never ages out on its own", () => {
  it("an UNKNOWN deal keeps blocking after 12 h (money may have moved); a stale HELD does not", () => {
    const old = new Date(Date.now() - 60 * 3_600_000).toISOString();
    expect(openHold(`${JSON.stringify({ dealId: "shs-1", listingId: "x", status: "UNKNOWN", at: old })}\n`)).not.toBeNull();
    expect(openHold(`${JSON.stringify({ dealId: "shs-1", listingId: "x", status: "HELD", at: old })}\n`)).toBeNull();
  });
});
