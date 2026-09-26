import { describe, it, expect } from "vitest";
import { openHold } from "@/ui/ShopAgent";

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
