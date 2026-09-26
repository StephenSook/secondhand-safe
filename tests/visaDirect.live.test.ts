import { describe, it, expect } from "vitest";
import { helloWorld, pushFunds, visaDirectCreds, VISA_DIRECT_ENV, type PayoutDoc, type PayoutStore } from "@/server/visa/direct";

/**
 * Visa Direct, live against the Visa Developer sandbox (sandbox.api.visa.com). Runs with `npm run test:live` only
 * when all five VISA_DIRECT_* variables are set: first the helloworld connectivity probe over two-way TLS, then
 * one real push funds transaction to Visa's sandbox test recipient card. The payout claim is kept in memory here,
 * so this test never writes to Atlas.
 */
const configured = VISA_DIRECT_ENV.every((k) => (process.env[k] ?? "").trim().length > 0);

function memoryStore(): PayoutStore {
  const docs = new Map<string, PayoutDoc>();
  return {
    async claim(doc) { if (docs.has(doc._id)) return { state: "exists", doc: docs.get(doc._id)! }; docs.set(doc._id, doc); return { state: "claimed" }; },
    async finish(id, f) { const d = docs.get(id); if (!d) return false; Object.assign(d, f); return true; },
  };
}

describe.skipIf(!configured)("Visa Direct sandbox, live", () => {
  it("helloworld answers 200 over two-way TLS", async () => {
    const r = await helloWorld(visaDirectCreds());
    console.log("helloworld", r.httpStatus, r.error ?? "");
    expect(r.ok).toBe(true);
  }, 30_000);

  it("one push funds transaction gets a definite answer from Visa", async () => {
    const dealId = `shs-live-${Date.now().toString(16)}`;
    const r = await pushFunds({ dealId, amountUsd: 12.34 }, { store: memoryStore() });
    console.log("push", r.status, r.httpStatus, r.actionCode ?? "", r.transactionIdentifier ?? "", r.note);
    // Visa's own published sandbox sample came back HTTP 200 with a non-00 action code, so a processed decline is
    // a definite answer too; what must not happen is a transport failure or an unreadable reply
    expect(r.httpStatus).toBe(200);
    expect(["SENT", "FAILED"]).toContain(r.status);
    expect(r.actionCode).toBeDefined();
  }, 60_000);
});
