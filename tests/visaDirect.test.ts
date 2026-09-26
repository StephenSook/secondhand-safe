import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  buildPushPayload, centsToAmount, classify, httpsTransport, mongoPayoutStore, pushFunds, toCents, traceNumbers, validPan, visaDirectCreds,
  TransportError, VISA_DIRECT_ENV, type PayoutDoc, type PayoutStore, type Transport,
} from "@/server/visa/direct";
import { integrationStatus } from "@/server/env";
import { boardDeal, recordPayout, type DealRecord } from "@/server/deals/store";
import { summarize } from "@/server/deals/trust";
import { payoutAfterCapture } from "@/server/deals/payout";

/** A Luhn-valid 16-digit test number built at run time (no card-number literal in the repo). */
function fakePan(): string {
  const body = "4" + Array.from({ length: 14 }, () => Math.floor(Math.random() * 10)).join("");
  for (let c = 0; c < 10; c++) if (validPan(body + c)) return body + c;
  throw new Error("unreachable");
}
const fakePem = (label: string) => ["-----BEGIN", `${label}-----`].join(" ") + "\n" + "QUJD".repeat(8) + "\n" + ["-----END", `${label}-----`].join(" ");
const fakeEnv = () => ({
  VISA_DIRECT_USER_ID: "test-user", VISA_DIRECT_PASSWORD: "test-pass",
  VISA_DIRECT_CERT: fakePem("CERTIFICATE"), VISA_DIRECT_KEY: fakePem("PRIVATE KEY"), VISA_DIRECT_CA: fakePem("CERTIFICATE"),
});

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
    expect(JSON.stringify(integrationStatus(fakeEnv()))).not.toContain("test-pass");
  });

  it("sends once and returns SENT with Visa's transaction id", async () => {
    const store = memoryStore();
    const t = approved();
    const r = await pushFunds({ dealId: "shs-1", amountUsd: 36.5, recipientPan: fakePan() }, { env: fakeEnv(), store, transport: t });
    expect(r).toMatchObject({ status: "SENT", actionCode: "00", transactionIdentifier: "381228649430015", httpStatus: 200 });
    const req = (t as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.path).toBe("/visadirect/fundstransfer/v1/pushfundstransactions");
    expect(JSON.parse(req.body).amount).toBe("36.50");
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

  it("a failure before the TLS handshake is FAILED (Visa never received it)", async () => {
    const t = vi.fn<Transport>(async () => { throw new TransportError("certificate rejected", false); });
    const r = await pushFunds({ dealId: "shs-tls", amountUsd: 3 }, { env: fakeEnv(), store: memoryStore(), transport: t });
    expect(r.status).toBe("FAILED");
  });

  it("an invalid amount or card is FAILED before anything is claimed", async () => {
    const store = memoryStore();
    expect((await pushFunds({ dealId: "shs-x", amountUsd: 1.005 }, { env: fakeEnv(), store, transport: approved() })).status).toBe("FAILED");
    expect((await pushFunds({ dealId: "shs-y", amountUsd: 1, recipientPan: "1234" }, { env: fakeEnv(), store, transport: approved() })).status).toBe("FAILED");
    expect(store.docs.size).toBe(0);
  });
});

describe("two-way TLS transport", () => {
  it("malformed PEM credentials fail before any connection, as not sent", async () => {
    const e = fakeEnv();
    const t = httpsTransport({ userId: "u", password: "p", cert: e.VISA_DIRECT_CERT, key: e.VISA_DIRECT_KEY, ca: e.VISA_DIRECT_CA, host: "sandbox.api.visa.com", acquiringBin: "408999" });
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
      ["shs-p3", async (r) => ({ httpStatus: 400, text: JSON.stringify({ responseStatus: { code: "3001", message: `Invalid PAN ${JSON.parse(r.body!).recipientPrimaryAccountNumber}` } }) })],
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

describe("trust console payouts", () => {
  it("counts payouts by outcome, empty when there are none", () => {
    const base = { amountUsd: 10, card: null, agent: null, createdAt: new Date().toISOString(), status: "CAPTURED" };
    expect(summarize([base]).payouts).toEqual({});
    const s = summarize([{ ...base, payout: { status: "SENT", amountUsd: 10 } }, { ...base, payout: { status: "SENT", amountUsd: 2.5 } }, { ...base, payout: { status: "UNCERTAIN", amountUsd: 4 } }]);
    expect(s.payouts).toEqual({ SENT: { n: 2, usd: 12.5 }, UNCERTAIN: { n: 1, usd: 4 } });
  });
});
