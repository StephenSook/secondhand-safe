import { describe, it, expect, vi } from "vitest";

/**
 * The recall call must never delay or fail the pickup answer. Here Visa (settle) answers REVERSED at once, the
 * settlement write resolves, and the call itself HANGS FOR EVER: the pickup response must still come straight back,
 * and the call is only ever handed to waitUntil.
 */
const pending: Promise<unknown>[] = [];
vi.mock("@vercel/functions", () => ({ waitUntil: (p: Promise<unknown>) => { pending.push(p); } }));
vi.mock("@/server/visa/creds", () => ({ visaCreds: () => ({ merchantId: "m", keyId: "k", secret: "s", host: "h" }) }));
vi.mock("@/server/deals/token", () => ({ verifyDealToken: () => ({ dealId: "shs-1", authId: "auth-1", amountUsd: 42, iat: Date.now() }) }));
vi.mock("@/server/deals/settle", async (orig) => ({ ...(await orig<typeof import("@/server/deals/settle")>()), settle: async () => ({ status: "REVERSED", visa: { id: "rev-1", status: "REVERSED", httpStatus: 201 } }) }));
vi.mock("@/server/deals/store", () => ({ recordSettlement: async () => true, recordSettlementStatus: async () => "REVERSED", getDeal: async () => ({ state: "missing" }) }));
// main's one-settlement-per-deal claim, on an in-memory store instead of Atlas
vi.mock("@/server/deals/claim", async (orig) => {
  const real = await orig<typeof import("@/server/deals/claim")>();
  return { ...real, mongoClaims: async () => real.memoryClaims() };
});
const hung = vi.fn((...args: unknown[]) => new Promise(() => void args));
vi.mock("@/server/call/pickup", () => ({ callAfterReversal: hung }));

describe("pickup with the recall call hanging", () => {
  it("answers REVERSED immediately and hands the call to waitUntil", async () => {
    const { POST } = await import("@/app/api/pickup/route");
    const t0 = Date.now();
    const res = await Promise.race([
      POST(new Request("http://x/api/pickup", { method: "POST", body: JSON.stringify({ token: "t", model: "BHC001", batch: "202408" }) })),
      new Promise<null>((ok) => setTimeout(() => ok(null), 3000)),
    ]);
    expect(res).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
    const j = await res!.json();
    expect(res!.status).toBe(200);
    expect(j.status).toBe("REVERSED");
    expect(hung).toHaveBeenCalledTimes(1);
    expect(hung.mock.calls[0]).toEqual(expect.arrayContaining(["shs-1"]));
    expect(pending.length).toBe(2); // the settlement write, and the call; neither awaited by the response
  });
});
