import { readFileSync, writeFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { helloWorld, pushFunds, visaDirectCreds, VISA_DIRECT_ENV, VISA_DIRECT_TLS_ENV, type PayoutDoc, type PayoutStore } from "@/server/visa/direct";

/**
 * Visa Direct, live against the Visa Developer sandbox (sandbox.api.visa.com). Runs with `npm run test:live` only
 * when all five VISA_DIRECT_* variables are set: first the helloworld connectivity probe over two-way TLS, then
 * one real push funds transaction to Visa's sandbox test recipient card. The payout claim is kept in memory here,
 * so this test never writes to Atlas.
 */
/** Local runs can point at the PEM files instead of pasting PEM text into env: VISA_DIRECT_CERT_FILE,
 *  VISA_DIRECT_KEY_FILE and VISA_DIRECT_CA_FILES (comma-separated, root then intermediate). Read at run time only. */
const e = process.env;
const fromFile = (paths: string | undefined) => paths ? paths.split(",").map((p) => readFileSync(p.trim(), "utf8").trim()).join("\n") : undefined;
if (!e.VISA_DIRECT_CERT?.trim()) e.VISA_DIRECT_CERT = fromFile(e.VISA_DIRECT_CERT_FILE);
if (!e.VISA_DIRECT_KEY?.trim()) e.VISA_DIRECT_KEY = fromFile(e.VISA_DIRECT_KEY_FILE);
if (!e.VISA_DIRECT_CA?.trim()) e.VISA_DIRECT_CA = fromFile(e.VISA_DIRECT_CA_FILES);
// Message Level Encryption (the push answers 400 / 9125 without it): VISA_DIRECT_MLE_KEY_ID plus these two files
if (!e.VISA_DIRECT_MLE_SERVER_CERT?.trim()) e.VISA_DIRECT_MLE_SERVER_CERT = fromFile(e.VISA_DIRECT_MLE_SERVER_CERT_FILE);
if (!e.VISA_DIRECT_MLE_PRIVATE_KEY?.trim()) e.VISA_DIRECT_MLE_PRIVATE_KEY = fromFile(e.VISA_DIRECT_MLE_PRIVATE_KEY_FILE);
const set = (keys: readonly string[]) => keys.every((k) => (process.env[k] ?? "").trim().length > 0);

function memoryStore(): PayoutStore & { docs: Map<string, PayoutDoc> } {
  const docs = new Map<string, PayoutDoc>();
  return {
    docs,
    async claim(doc) { if (docs.has(doc._id)) return { state: "exists", doc: docs.get(doc._id)! }; docs.set(doc._id, doc); return { state: "claimed" }; },
    async finish(id, f) { const d = docs.get(id); if (!d) return false; Object.assign(d, f); return true; },
    async release(id) { return docs.delete(id); },
  };
}

describe.skipIf(!set(VISA_DIRECT_TLS_ENV))("Visa Direct sandbox, live", () => {
  it("helloworld answers 200 over two-way TLS", async () => {
    const r = await helloWorld(visaDirectCreds(process.env, "optional"));
    console.log("helloworld", r.httpStatus, r.error ?? "");
    if (e.VISA_DIRECT_LIVE_REPORT) writeFileSync(`${e.VISA_DIRECT_LIVE_REPORT}.hello`, JSON.stringify({ httpStatus: r.httpStatus, ok: r.ok }) + "\n");
    expect(r.ok).toBe(true);
  }, 30_000);

  // needs Message Level Encryption too: our project answers 400 / 9125 to a push without it
  it.skipIf(!set(VISA_DIRECT_ENV))("one push funds transaction gets a definite answer from Visa", async () => {
    const dealId = `shs-live-${Date.now().toString(16)}`;
    const store = memoryStore();
    const r = await pushFunds({ dealId, amountUsd: 12.34 }, { store });
    const d = store.docs.get(dealId);
    // presence only for Visa's ids; never the card number
    const report = JSON.stringify({ status: r.status, httpStatus: r.httpStatus, actionCode: r.actionCode ?? null, errorCode: d?.errorCode ?? null,
      approvalCode: Boolean(d?.approvalCode), transactionIdentifier: Boolean(d?.transactionIdentifier), correlationId: Boolean(d?.correlationId), note: r.note });
    console.log("push", report);
    // vitest hides the console of passing tests: VISA_DIRECT_LIVE_REPORT=<path> keeps the outcome of this one push
    if (e.VISA_DIRECT_LIVE_REPORT) writeFileSync(e.VISA_DIRECT_LIVE_REPORT, report + "\n");
    // Visa's own published sandbox sample came back HTTP 200 with a non-00 action code, so a processed decline is
    // a definite answer too; what must not happen is a transport failure or an unreadable reply
    expect(r.httpStatus).toBe(200);
    expect(["SENT", "FAILED"]).toContain(r.status);
    expect(r.actionCode).toBeDefined();
  }, 60_000);
});
