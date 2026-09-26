import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";

/** In-memory stand-in for the two Atlas collections the payout touches, with Mongo's _id uniqueness. */
const db = vi.hoisted(() => {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const writes: unknown[] = [];
  const col = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    const m = collections.get(name)!;
    return {
      async insertOne(doc: Record<string, unknown>) {
        await new Promise((ok) => setTimeout(ok, 1)); // let concurrent callers interleave
        writes.push(doc);
        if (m.has(doc._id as string)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
        m.set(doc._id as string, { ...doc });
        return { acknowledged: true };
      },
      async findOne(q: { _id: string }) { return m.get(q._id) ?? null; },
      async updateOne(q: { _id: string; state?: string }, u: { $set?: Record<string, unknown>; $push?: Record<string, unknown> }) {
        writes.push(u);
        const d = m.get(q._id);
        if (!d || (q.state && d.state !== q.state)) return { matchedCount: 0, modifiedCount: 0 };
        Object.assign(d, u.$set ?? {});
        return { matchedCount: 1, modifiedCount: 1 };
      },
    };
  };
  return { collections, writes, db: { collection: (n: string) => col(n) }, on: true };
});
vi.mock("@/server/db/mongo", () => ({ getDb: async () => (db.on ? db.db : null) }));

import {
  buildPushPayload, centsToAmount, classify, httpsTransport, mleDecrypt, mleEncrypt, mongoPayoutStore, pushFunds, toCents, traceNumbers, validPan, visaDirectCreds,
  TransportError, VISA_DIRECT_ENV, type PayoutDoc, type PayoutStore, type Transport,
} from "@/server/visa/direct";
import { integrationStatus } from "@/server/env";
import { boardDeal, recordPayout, recordSettlementStatus, type DealRecord } from "@/server/deals/store";
import { summarize } from "@/server/deals/trust";
import { payoutAfterCapture } from "@/server/deals/payout";

/** A Luhn-valid 16-digit test number built at run time (no card-number literal in the repo). */
function fakePan(): string {
  const body = "4" + Array.from({ length: 14 }, () => Math.floor(Math.random() * 10)).join("");
  for (let c = 0; c < 10; c++) if (validPan(body + c)) return body + c;
  throw new Error("unreachable");
}
const fakePem = (label: string) => ["-----BEGIN", `${label}-----`].join(" ") + "\n" + "QUJD".repeat(8) + "\n" + ["-----END", `${label}-----`].join(" ");
/** Stands in for Visa's MLE server key pair and ours, generated at run time. */
const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const mleServer = rsa(), mleClient = rsa();
const fakeEnv = () => ({
  VISA_DIRECT_USER_ID: "test-user", VISA_DIRECT_PASSWORD: "test-pass",
  VISA_DIRECT_CERT: fakePem("CERTIFICATE"), VISA_DIRECT_KEY: fakePem("PRIVATE KEY"), VISA_DIRECT_CA: fakePem("CERTIFICATE"),
  VISA_DIRECT_MLE_KEY_ID: "kid-test", VISA_DIRECT_MLE_SERVER_CERT: mleServer.publicKey, VISA_DIRECT_MLE_PRIVATE_KEY: mleClient.privateKey,
});
/** What Visa would read after decrypting our request. */
const sentPayload = (body: string) => JSON.parse(mleDecrypt(JSON.parse(body).encData, mleServer.privateKey));

function memoryStore(): PayoutStore & { docs: Map<string, PayoutDoc> } {
  const docs = new Map<string, PayoutDoc>();
  return {
    docs,
    async claim(doc) {
      await new Promise((ok) => setTimeout(ok, Math.random() * 3));
      if (docs.has(doc._id)) return { state: "exists", doc: docs.get(doc._id)! };
      docs.set(doc._id, { ...doc });
      return { state: "claimed" };
    },
    async finish(id, f) { const d = docs.get(id); if (!d || d.state !== "CLAIMED") return false; Object.assign(d, f); return true; },
    async release(id) { const d = docs.get(id); if (!d || d.state !== "CLAIMED") return false; docs.delete(id); return true; },
  };
}
const approved = (): Transport => vi.fn(async () => ({ httpStatus: 200, text: JSON.stringify({ actionCode: "00", transactionIdentifier: 381228649430015, approvalCode: "20304B" }) }));

beforeEach(() => { db.collections.clear(); db.writes.length = 0; db.on = true; });
afterEach(() => { vi.restoreAllMocks(); });

describe("payload builder", () => {
  it("amounts are integer cents end to end, with no float drift", () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(64)).toBe(6400);
    expect(centsToAmount(1999)).toBe("19.99");
    expect(centsToAmount(5)).toBe("0.05");
    expect(centsToAmount(100000)).toBe("1000.00");
    expect(() => toCents(19.999)).toThrow(/two decimals/);
    expect(() => toCents(0)).toThrow();
    expect(() => toCents(Number.NaN)).toThrow();
    expect(() => centsToAmount(19.5)).toThrow();
  });

  it("builds Visa's push fields for one deal", () => {
    const now = new Date(Date.UTC(2026, 8, 26, 14, 5, 9));
    const pan = fakePan();
    const p = buildPushPayload({ dealId: "shs-0123abcd-4567", amountCents: 3650, recipientPan: pan, acquiringBin: "408999", now });
    expect(p.amount).toBe("36.50");
    expect(p.recipientPrimaryAccountNumber).toBe(pan);
    expect(p.acquiringBin).toBe("408999");
    expect(p.acquirerCountryCode).toBe("840");
    expect(p.transactionCurrencyCode).toBe("USD");
    expect(p.businessApplicationId).toBe("AA");
    expect(p.localTransactionDateTime).toBe("2026-09-26T14:05:09");
    expect(p.systemsTraceAuditNumber).toMatch(/^\d{6}$/);
    // ydddhhnnnnnn: 2026 -> 6, Sep 26 is day 269, 14h, then the trace number
    expect(p.retrievalReferenceNumber).toBe(`626914${p.systemsTraceAuditNumber}`);
    expect(p).not.toHaveProperty("transactionIdentifier"); // only when a push follows a pull
  });

  it("trace numbers are stable per deal and the julian day stays in 1..366", () => {
    const a = traceNumbers("shs-a", new Date(Date.UTC(2028, 11, 31, 23)));
    expect(a.rrn.slice(1, 4)).toBe("366");
    expect(traceNumbers("shs-a", new Date(Date.UTC(2026, 0, 1))).rrn.slice(1, 4)).toBe("001");
    expect(traceNumbers("shs-a", new Date()).stan).toBe(a.stan);
    expect(traceNumbers("shs-b", new Date()).stan).not.toBe(a.stan);
  });

  it("maps Visa action codes per the published table: 00 and 11 approve, 10 is partial, the rest decline", () => {
    expect(classify(200, { actionCode: "00", approvalCode: "A1" })).toMatchObject({ status: "SENT", actionCode: "00" });
    expect(classify(200, { actionCode: "11", approvalCode: "A1" })).toMatchObject({ status: "SENT", actionCode: "11" });
    const partial = classify(200, { actionCode: "10", amount: "6.17" });
    expect(partial).toMatchObject({ status: "UNCERTAIN", actionCode: "10", processedAmount: "6.17" });
    expect(partial.note).toMatch(/partially approved/);
    expect(classify(200, { actionCode: "10" })).toMatchObject({ status: "UNCERTAIN" });
    expect(classify(200, { actionCode: "10" })).not.toHaveProperty("processedAmount");
    for (const code of ["65", "05", "51", "01", "12"]) expect(classify(200, { actionCode: code })).toMatchObject({ status: "FAILED", actionCode: code });
  });

  it("an 11 is recorded SENT and a 10 is stored UNCERTAIN with the stated amount, never a full success", async () => {
    const store = memoryStore();
    const t11 = vi.fn<Transport>(async () => ({ httpStatus: 200, text: '{"actionCode":"11","transactionIdentifier":9}' }));
    expect((await pushFunds({ dealId: "shs-11", amountUsd: 4, recipientPan: fakePan() }, { env: fakeEnv(), store, transport: t11 })).status).toBe("SENT");
    const t10 = vi.fn<Transport>(async () => ({ httpStatus: 200, text: '{"actionCode":"10","amount":"2.00"}' }));
    const r = await pushFunds({ dealId: "shs-10", amountUsd: 4, recipientPan: fakePan() }, { env: fakeEnv(), store, transport: t10 });
    expect(r.status).toBe("UNCERTAIN");
    expect(store.docs.get("shs-10")).toMatchObject({ state: "UNCERTAIN", actionCode: "10", processedAmount: "2.00" });
  });

  it("classifies Visa's answers", () => {
    expect(classify(200, { actionCode: "00", transactionIdentifier: 1 }).status).toBe("SENT");
    expect(classify(200, { actionCode: "65" })).toMatchObject({ status: "FAILED", actionCode: "65" });
    expect(classify(200, {}).status).toBe("UNCERTAIN");
    expect(classify(202, { statusIdentifier: "abc" })).toMatchObject({ status: "UNCERTAIN", statusIdentifier: "abc" });
    expect(classify(303, {}).status).toBe("UNCERTAIN");
    expect(classify(400, { responseStatus: { code: "3001", message: "Invalid PAN" } })).toMatchObject({ status: "FAILED", errorCode: "3001" });
    expect(classify(401, {}).status).toBe("FAILED");
    expect(classify(500, {}).status).toBe("UNCERTAIN");
    expect(classify(504, null).status).toBe("UNCERTAIN");
  });

  it("reads PEM text written on one line with literal \\n", () => {
    const e = fakeEnv();
    const c = visaDirectCreds({ ...e, VISA_DIRECT_CERT: e.VISA_DIRECT_CERT.replace(/\n/g, "\\n") });
    expect(c.cert).toBe(e.VISA_DIRECT_CERT);
    expect(c.host).toBe("sandbox.api.visa.com");
    expect(c.acquiringBin).toBe("408999");
  });
});

describe("pushFunds", () => {
  it("is NOT_CONFIGURED without all five env vars, and then claims and sends nothing", async () => {
    const store = memoryStore();
    const t = approved();
    for (const drop of [...VISA_DIRECT_ENV, "all"]) {
      const env: Record<string, string | undefined> = drop === "all" ? {} : { ...fakeEnv(), [drop]: "" };
      const r = await pushFunds({ dealId: "shs-nc", amountUsd: 10 }, { env, store, transport: t });
      expect(r.status).toBe("NOT_CONFIGURED");
      expect(integrationStatus(env).visaDirect).toBe(false);
    }
    expect(t).not.toHaveBeenCalled();
    expect(store.docs.size).toBe(0);
    expect(integrationStatus(fakeEnv()).visaDirect).toBe(true);
    // two-way TLS alone is enough for helloworld, not for a payout (the push endpoint enforces MLE)
    const tlsOnly = { ...fakeEnv(), VISA_DIRECT_MLE_KEY_ID: "", VISA_DIRECT_MLE_SERVER_CERT: "", VISA_DIRECT_MLE_PRIVATE_KEY: "" };
    expect(visaDirectCreds(tlsOnly, "optional").mle).toBeNull();
    expect(integrationStatus(tlsOnly).visaDirect).toBe(false);
    expect(JSON.stringify(integrationStatus(fakeEnv()))).not.toContain("test-pass");
  });

  it("sends once and returns SENT with Visa's transaction id", async () => {
    const store = memoryStore();
    const t = approved();
    const r = await pushFunds({ dealId: "shs-1", amountUsd: 36.5, recipientPan: fakePan() }, { env: fakeEnv(), store, transport: t });
    expect(r).toMatchObject({ status: "SENT", actionCode: "00", transactionIdentifier: "381228649430015", httpStatus: 200 });
    const req = (t as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.path).toBe("/visadirect/fundstransfer/v1/pushfundstransactions");
    expect(sentPayload(req.body).amount).toBe("36.50");
    expect(req.headers.keyId).toBe("kid-test");
    expect(req.headers["x-client-transaction-id"]).toBe("lullabuy-payout-shs-1");
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from("test-user:test-pass").toString("base64")}`);
    expect(store.docs.get("shs-1")?.state).toBe("SENT");
  });

  it("concurrent payouts for one deal produce exactly one send", async () => {
    const store = memoryStore();
    const t = vi.fn<Transport>(async () => { await new Promise((ok) => setTimeout(ok, 5)); return { httpStatus: 200, text: '{"actionCode":"00","transactionIdentifier":7}' }; });
    const results = await Promise.all(Array.from({ length: 25 }, () => pushFunds({ dealId: "shs-race", amountUsd: 20 }, { env: fakeEnv(), store, transport: t })));
    expect(t).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(24);
  });

  it("the same holds through the Atlas claim: a second insert on _id is a duplicate, never a second send", async () => {
    const t = vi.fn<Transport>(async () => ({ httpStatus: 200, text: '{"actionCode":"00"}' }));
    const results = await Promise.all(Array.from({ length: 10 }, () => pushFunds({ dealId: "shs-atlas", amountUsd: 5 }, { env: fakeEnv(), store: mongoPayoutStore(), transport: t })));
    expect(t).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(db.collections.get("payouts")?.get("shs-atlas")?.state).toBe("SENT");
  });

  it("refuses to send when the claim store is unavailable", async () => {
    db.on = false;
    const t = approved();
    const r = await pushFunds({ dealId: "shs-nodb", amountUsd: 5 }, { env: fakeEnv(), store: mongoPayoutStore(), transport: t });
    expect(r.status).toBe("FAILED");
    expect(t).not.toHaveBeenCalled();
  });

  it("a timeout is stored as UNCERTAIN and never re-sent", async () => {
    const store = memoryStore();
    const t = vi.fn<Transport>(async () => { throw new TransportError("timed out after 15000 ms", true, true); });
    const first = await pushFunds({ dealId: "shs-slow", amountUsd: 12 }, { env: fakeEnv(), store, transport: t });
    expect(first.status).toBe("UNCERTAIN");
    expect(store.docs.get("shs-slow")?.state).toBe("UNCERTAIN");
    const again = await pushFunds({ dealId: "shs-slow", amountUsd: 12 }, { env: fakeEnv(), store, transport: approved() });
    expect(again).toMatchObject({ status: "UNCERTAIN", duplicate: true });
    expect(t).toHaveBeenCalledTimes(1);
  });

  it("a claim left behind by a crash reads as UNCERTAIN and is not re-sent", async () => {
    const store = memoryStore();
    store.docs.set("shs-crash", { _id: "shs-crash", state: "CLAIMED", amountCents: 100, recipientLast4: "0000", stan: "000001", rrn: "626914000001", claimedAt: "x" });
    const t = approved();
    const r = await pushFunds({ dealId: "shs-crash", amountUsd: 1 }, { env: fakeEnv(), store, transport: t });
    expect(r).toMatchObject({ status: "UNCERTAIN", duplicate: true });
    expect(t).not.toHaveBeenCalled();
  });

  it("a failure before the TLS handshake is FAILED, releases the claim, and a later attempt sends once", async () => {
    const store = memoryStore();
    const t = vi.fn<Transport>(async () => { throw new TransportError("getaddrinfo ENOTFOUND", false); });
    const r = await pushFunds({ dealId: "shs-tls", amountUsd: 3 }, { env: fakeEnv(), store, transport: t });
    expect(r.status).toBe("FAILED");
    expect(store.docs.has("shs-tls")).toBe(false);
    const ok = approved();
    expect((await pushFunds({ dealId: "shs-tls", amountUsd: 3 }, { env: fakeEnv(), store, transport: ok })).status).toBe("SENT");
    expect((await pushFunds({ dealId: "shs-tls", amountUsd: 3 }, { env: fakeEnv(), store, transport: ok })).duplicate).toBe(true);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("when the release fails, the claim is closed as FAILED and still never re-sent", async () => {
    const store = memoryStore();
    store.release = async () => false;
    const t = vi.fn<Transport>(async () => { throw new TransportError("ECONNREFUSED", false); });
    expect((await pushFunds({ dealId: "shs-norel", amountUsd: 3 }, { env: fakeEnv(), store, transport: t })).status).toBe("FAILED");
    expect(store.docs.get("shs-norel")?.state).toBe("FAILED");
    const ok = approved();
    expect((await pushFunds({ dealId: "shs-norel", amountUsd: 3 }, { env: fakeEnv(), store, transport: ok })).duplicate).toBe(true);
    expect(ok).not.toHaveBeenCalled();
  });

  it("asks Visa to answer 202 before our own timeout", async () => {
    const t = approved();
    await pushFunds({ dealId: "shs-hdr", amountUsd: 3 }, { env: fakeEnv(), store: memoryStore(), transport: t });
    expect(Number((t as ReturnType<typeof vi.fn>).mock.calls[0][0].headers["x-transaction-timeout-ms"])).toBeLessThan(15_000);
  });

  it("an invalid amount or card is FAILED before anything is claimed", async () => {
    const store = memoryStore();
    expect((await pushFunds({ dealId: "shs-x", amountUsd: 1.005 }, { env: fakeEnv(), store, transport: approved() })).status).toBe("FAILED");
    expect((await pushFunds({ dealId: "shs-y", amountUsd: 1, recipientPan: "1234" }, { env: fakeEnv(), store, transport: approved() })).status).toBe("FAILED");
    expect(store.docs.size).toBe(0);
  });
});

describe("Message Level Encryption", () => {
  const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  it("JWE round trip with Visa's header fields", () => {
    const k = pair();
    const jwe = mleEncrypt('{"amount":"12.34"}', { keyId: "kid-1", serverCert: k.publicKey }, 1_700_000_000_000);
    const parts = jwe.split(".");
    expect(parts).toHaveLength(5);
    expect(JSON.parse(Buffer.from(parts[0], "base64url").toString())).toEqual({ alg: "RSA-OAEP-256", enc: "A128GCM", iat: 1_700_000_000_000, kid: "kid-1" });
    expect(mleDecrypt(jwe, k.privateKey)).toBe('{"amount":"12.34"}');
    const tampered = [parts[0], parts[1], parts[2], parts[3].slice(0, -2) + (parts[3].endsWith("A") ? "BB" : "AA"), parts[4]].join(".");
    expect(() => mleDecrypt(tampered, k.privateKey)).toThrow();
  });
  it("pushFunds encrypts the body, sends keyId, and decrypts Visa's reply", async () => {
    const server = pair(), client = pair();
    const env = { ...fakeEnv(), VISA_DIRECT_MLE_KEY_ID: "kid-2", VISA_DIRECT_MLE_SERVER_CERT: server.publicKey, VISA_DIRECT_MLE_PRIVATE_KEY: client.privateKey };
    const pan = fakePan();
    const t = vi.fn<Transport>(async (r) => {
      const sent = JSON.parse(r.body!);
      expect(Object.keys(sent)).toEqual(["encData"]);
      expect(r.body).not.toContain(pan);
      expect(JSON.parse(mleDecrypt(sent.encData, server.privateKey)).recipientPrimaryAccountNumber).toBe(pan);
      const reply = mleEncrypt(JSON.stringify({ actionCode: "00", transactionIdentifier: 42 }), { keyId: "kid-2", serverCert: client.publicKey });
      return { httpStatus: 200, text: JSON.stringify({ encData: reply }) };
    });
    const r = await pushFunds({ dealId: "shs-mle", amountUsd: 5, recipientPan: pan }, { env, store: memoryStore(), transport: t });
    expect(t.mock.calls[0][0].headers.keyId).toBe("kid-2");
    expect(r).toMatchObject({ status: "SENT", transactionIdentifier: "42" });
  });
  it("a bad MLE certificate is FAILED and nothing reaches the transport", async () => {
    const t = approved();
    const store = memoryStore();
    const r = await pushFunds({ dealId: "shs-badmle", amountUsd: 5 }, { env: { ...fakeEnv(), VISA_DIRECT_MLE_SERVER_CERT: fakePem("CERTIFICATE") }, store, transport: t });
    expect(r.status).toBe("FAILED");
    expect(t).not.toHaveBeenCalled();
    expect(store.docs.has("shs-badmle")).toBe(false); // released: nothing was sent
  });
  it("names MLE when Visa answers 9125", () => {
    expect(classify(400, { responseStatus: { code: "9125", message: "Expected input credential was not present" } }).note).toMatch(/Message Level Encryption/);
  });
});

describe("two-way TLS transport", () => {
  it("malformed PEM credentials fail before any connection, as not sent", async () => {
    const e = fakeEnv();
    const t = httpsTransport({ userId: "u", password: "p", cert: e.VISA_DIRECT_CERT, key: e.VISA_DIRECT_KEY, ca: e.VISA_DIRECT_CA, host: "sandbox.api.visa.com", acquiringBin: "408999", mle: null });
    const err = await t({ method: "GET", path: "/vdp/helloworld", headers: {} }).then(() => null, (x: unknown) => x);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).sent).toBe(false);
    const r = await pushFunds({ dealId: "shs-badpem", amountUsd: 1 }, { env: fakeEnv(), store: memoryStore() });
    expect(r.status).toBe("FAILED");
  });
});

describe("the card number never leaves the module", () => {
  it("not in logs, the private claim, the deal timeline or any public record", async () => {
    const lines: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    const deals = db.db.collection("deals");
    const outcomes: [string, Transport][] = [
      ["shs-p1", approved()],
      ["shs-p2", async () => { throw new TransportError("socket hang up", true); }],
      // a rejection that echoes the card number back must not carry it anywhere
      ["shs-p3", async (r) => ({ httpStatus: 400, text: JSON.stringify({ responseStatus: { code: "3001", message: `Invalid PAN ${sentPayload(r.body!).recipientPrimaryAccountNumber}` } }) })],
    ];
    const pan = fakePan();
    const records: unknown[] = [];
    for (const [id, t] of outcomes) {
      await deals.insertOne({ _id: id, listing: "t", amountUsd: 9.5, status: "CAPTURED", card: null, agent: null, createdAt: "x", updatedAt: "x", events: [] });
      const r = await pushFunds({ dealId: id, amountUsd: 9.5, recipientPan: pan }, { env: fakeEnv(), store: mongoPayoutStore(), transport: t });
      records.push(r);
      expect(r.recipient).toBe(`card ending ${pan.slice(-4)}`);
      expect(await recordPayout(r)).toBe(true);
      records.push(boardDeal((await deals.findOne({ _id: id })) as unknown as DealRecord));
    }
    const everything = JSON.stringify([lines, records, db.writes, [...(db.collections.get("payouts")?.values() ?? [])]]);
    expect(everything).not.toContain(pan);
    expect(everything).not.toContain(pan.slice(0, 12));
    expect(everything).toContain(pan.slice(-4));
    expect(everything).not.toContain("test-pass");
  });

  it("NOT_CONFIGURED and duplicates are never written to the deal timeline", async () => {
    const before = db.writes.length;
    expect(await recordPayout({ status: "NOT_CONFIGURED", dealId: "shs-z", amountUsd: 1, recipient: null, note: "" })).toBe(false);
    expect(await recordPayout({ status: "SENT", dealId: "shs-z", amountUsd: 1, recipient: null, note: "", duplicate: true })).toBe(false);
    expect(db.writes.length).toBe(before);
  });

  it("payoutAfterCapture never throws", async () => {
    db.on = false; // the timeline write degrades too, quickly
    const t = vi.fn<Transport>(async () => { throw new Error("boom"); });
    await expect(payoutAfterCapture({ dealId: "shs-never", amountUsd: 2 }, { env: fakeEnv(), store: memoryStore(), transport: t })).resolves.toMatchObject({ status: "UNCERTAIN" });
  });
});

describe("recordSettlementStatus", () => {
  it("returns the status the write left behind, not the one it was asked to write", async () => {
    const deals = db.db.collection("deals") as unknown as Record<string, unknown>;
    deals.findOneAndUpdate = async () => ({ _id: "shs-rev", status: "REVERSED" });
    const orig = db.db.collection;
    db.db.collection = ((n: string) => (n === "deals" ? deals : orig(n))) as typeof db.db.collection;
    try {
      expect(await recordSettlementStatus("shs-rev", { status: "CAPTURED", verdict: { kind: "NO_MATCH", reason: "r" } })).toBe("REVERSED");
    } finally { db.db.collection = orig; }
  });
});

describe("trust console payouts", () => {
  it("counts payouts by outcome, empty when there are none", () => {
    const base = { amountUsd: 10, card: null, agent: null, createdAt: new Date().toISOString(), status: "CAPTURED" };
    expect(summarize([base]).payouts).toEqual({});
    const s = summarize([{ ...base, payout: { status: "SENT", amountUsd: 10 } }, { ...base, payout: { status: "SENT", amountUsd: 2.5 } }, { ...base, payout: { status: "UNCERTAIN", amountUsd: 4 } }]);
    expect(s.payouts).toEqual({ SENT: { n: 2, usd: 12.5 }, UNCERTAIN: { n: 1, usd: 4 } });
  });
});
