import { describe, expect, it } from "vitest";
import { canSettle, kioskState, mergeRecord, readDealToken } from "@/core/kiosk";
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
  });
});
