import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Route-level regression (Codex review of PR #44): the Visa Direct payout is gated on the deal's EFFECTIVE stored
 * status after the settlement write, never on "the write matched". A reversal recorded first, then a delayed capture
 * for the same deal, must send no payout.
 */
const h = vi.hoisted(() => ({
  effective: "CAPTURED" as string | null,
  pending: [] as Promise<unknown>[],
  payout: vi.fn(async () => null),
  settleStatus: "CAPTURED",
  claims: null as unknown,
}));
vi.mock("@vercel/functions", () => ({ waitUntil: (p: Promise<unknown>) => { h.pending.push(p); } }));
vi.mock("@/server/visa/creds", () => ({ visaCreds: () => ({ merchantId: "m", keyId: "k", secret: "c2VjcmV0", host: "apitest.cybersource.com" }) }));
vi.mock("@/server/deals/token", () => ({ verifyDealToken: () => ({ dealId: "shs-0123abcd-4567", authId: "auth-1", amountUsd: 36 }) }));
vi.mock("@/server/deals/settle", async (orig) => ({ ...(await orig<typeof import("@/server/deals/settle")>()), settle: async () => ({ status: h.settleStatus, visa: { ok: true, status: "PENDING", id: "cap-1", httpStatus: 201, parsed: true, raw: {} } }) }));
vi.mock("@/server/deals/store", () => ({ recordSettlementStatus: async () => h.effective, getDeal: async () => ({ state: "missing" }) }));
// main's one-settlement-per-deal claim, on an in-memory store (fresh per test) instead of Atlas
vi.mock("@/server/deals/claim", async (orig) => ({ ...(await orig<typeof import("@/server/deals/claim")>()), mongoClaims: async () => h.claims }));
vi.mock("@/server/deals/payout", () => ({ payoutAfterCapture: h.payout }));

import { POST } from "@/app/api/pickup/route";
import { memoryClaims } from "@/server/deals/claim";

async function pickup() {
  const res = await POST(new Request("http://x/api/pickup", { method: "POST", body: JSON.stringify({ token: "t", model: "ZZT9Q41X" }) }));
  await Promise.all(h.pending);
  return res;
}

beforeEach(() => { h.pending.length = 0; h.payout.mockClear(); h.settleStatus = "CAPTURED"; h.claims = memoryClaims(); vi.stubEnv("SOLANA_SECRET_KEY_B58", ""); });

describe("pickup -> Visa Direct payout gate", () => {
  it("a capture whose deal is stored CAPTURED pays the seller once", async () => {
    h.effective = "CAPTURED";
    expect((await (await pickup()).json()).status).toBe("CAPTURED");
    expect(h.payout).toHaveBeenCalledTimes(1);
    expect(h.payout).toHaveBeenCalledWith({ dealId: "shs-0123abcd-4567", amountUsd: 36 });
  });

  for (const kept of ["REVERSED", "RELEASED", "LAPSED"]) {
    it(`a reversal recorded first (${kept}), then a delayed capture: no payout`, async () => {
      h.effective = kept;
      expect((await (await pickup()).json()).status).toBe("CAPTURED"); // what Visa answered this request
      expect(h.payout).not.toHaveBeenCalled();
    });
  }

  it("a second scan of the same captured deal replays the answer and never pays out twice", async () => {
    h.effective = "CAPTURED";
    await pickup();
    const again = await (await pickup()).json();
    expect(again.replayed).toBe(true);
    expect(h.payout).toHaveBeenCalledTimes(1);
  });

  it("no deal record or a failed write: no payout", async () => {
    h.effective = null;
    await pickup();
    expect(h.payout).not.toHaveBeenCalled();
  });

  it("a reversal never pays out", async () => {
    h.settleStatus = "REVERSED"; h.effective = "REVERSED";
    await pickup();
    expect(h.payout).not.toHaveBeenCalled();
  });
});
