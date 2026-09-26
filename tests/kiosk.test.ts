import { describe, expect, it } from "vitest";
import { canSettle, kioskState, mergeRecord, readDealToken, recordApplies } from "@/core/kiosk";
import { issueDealToken } from "@/server/deals/token";

describe("table kiosk state", () => {
  it("reads the display fields of a real deal token, from the bare token or surrounding text", () => {
    const token = issueDealToken("test-secret", { dealId: "shs-0a1b2c3d4e", authId: "7000000000000000000000", amountUsd: 45 }, 1_700_000_000_000);
    expect(readDealToken(token)).toEqual({ token, dealId: "shs-0a1b2c3d4e", amountUsd: 45, issuedAt: 1_700_000_000_000 });
    expect(readDealToken(`deal token: ${token} (copied)`)?.token).toBe(token);
  });

  it("refuses text that is not a deal token", () => {
    expect(readDealToken("hello")).toBeNull();
    expect(readDealToken("aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb")).toBeNull();
    const notADeal = `${Buffer.from(JSON.stringify({ dealId: "other", amountUsd: 1, iat: 1 })).toString("base64url")}.${"x".repeat(43)}`;
    expect(readDealToken(notADeal)).toBeNull();
  });

  it("maps each status to one kiosk state; a kept hold after a scan is NEEDS_CHECK", () => {
    expect(kioskState(null)).toBe("IDLE");
    expect(kioskState("HELD")).toBe("HELD");
    expect(kioskState("HELD", "NEEDS_CHECK")).toBe("NEEDS_CHECK");
    expect(kioskState("HELD", "UNREADABLE")).toBe("NEEDS_CHECK");
    expect(kioskState("CAPTURED", "NO_MATCH")).toBe("CAPTURED");
    expect(kioskState("REVERSED", "RECALL_MATCH")).toBe("REVERSED");
    expect(kioskState("REFUSED")).toBe("REFUSED");
    expect(kioskState("UNKNOWN")).toBe("UNKNOWN");
    expect(kioskState("LAPSED")).toBe("CLOSED");
  });

  it("only an open hold can be settled; UNKNOWN never can (money may have moved)", () => {
    expect(canSettle("HELD")).toBe(true);
    for (const s of ["CAPTURED", "REVERSED", "REFUSED", "UNKNOWN", "RELEASED", "LAPSED"] as const) expect(canSettle(s)).toBe(false);
  });

  it("the deal record can close a HELD kiosk but never reopens a settled one", () => {
    expect(mergeRecord("HELD", "CAPTURED")).toBe("CAPTURED");
    expect(mergeRecord("HELD", undefined)).toBe("HELD");
    expect(mergeRecord("CAPTURED", "HELD")).toBe("CAPTURED");
    expect(mergeRecord("UNKNOWN", "HELD")).toBe("UNKNOWN");
    expect(mergeRecord("REVERSED", "CAPTURED")).toBe("REVERSED");
  });

  it("an authoritative final record resolves UNKNOWN (lost answer) and REFUSED (lost race); a non-final one does not", () => {
    for (const rec of ["CAPTURED", "REVERSED", "RELEASED", "LAPSED"] as const) {
      expect(mergeRecord("UNKNOWN", rec)).toBe(rec);
      expect(mergeRecord("REFUSED", rec)).toBe(rec);
    }
    expect(mergeRecord("UNKNOWN", "REFUSED")).toBe("UNKNOWN");
    expect(mergeRecord("REFUSED", "UNKNOWN")).toBe("REFUSED");
  });

  it("REGRESSION: a delayed record answer for deal A never applies after deal B is attached", () => {
    const A = "shs-aaaaaaaa01", B = "shs-bbbbbbbb02";
    expect(recordApplies(A, B, { dealId: A })).toBe(false); // asked for A, B is attached now
    expect(recordApplies(A, undefined, { dealId: A })).toBe(false); // detached
    expect(recordApplies(B, B, { dealId: A })).toBe(false); // the answer is for another deal
    expect(recordApplies(B, B, { dealId: B })).toBe(true);
    expect(recordApplies(B, B, null)).toBe(true); // "not available" for the attached deal still shows
  });
});
