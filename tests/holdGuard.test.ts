import { describe, it, expect } from "vitest";
import { openHold, explicitlyNoHold } from "@/ui/holdGuard";

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
