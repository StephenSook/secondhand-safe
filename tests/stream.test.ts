import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { ChangeStreamDocument } from "mongodb";
import type { DealRecord } from "@/server/deals/store";

// The driver is mocked: unit tests never reach Atlas. `db` is swapped per test.
const mongo = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/server/db/mongo", () => ({ getDb: async () => mongo.db }));

import { GET } from "@/app/api/stream/route";
import { MAX_STREAMS, activeStreams, dealFrame, parseResume } from "@/server/deals/stream";
import { boardDeal } from "@/server/deals/store";
import { DEMO_TABLE } from "@/core/demoTable";

const record = (over: Partial<DealRecord> = {}): DealRecord => ({
  _id: "shs-0123abcd-4567", listing: "Graco crib, pick up in Decatur, call 404-555-0101", amountUsd: 40, status: "HELD",
  card: "microform", agent: null, authId: "7412345678901234567890", sweepAttemptAt: "2026-09-26T10:00:00.000Z",
  createdAt: "2026-09-26T09:00:00.000Z", updatedAt: "2026-09-26T09:00:00.000Z",
  events: [{ at: "2026-09-26T09:00:00.000Z", status: "HELD", note: "Visa authorized $40.00 with capture off" }], ...over,
});
const change = (doc: DealRecord | undefined, op: "insert" | "update" | "delete" = "insert") =>
  ({ _id: { _data: "8266F0A1B2000000012B" }, operationType: op, documentKey: { _id: "shs-0123abcd-4567" }, fullDocument: doc }) as unknown as ChangeStreamDocument<DealRecord>;

/** A fake change stream: tryNext answers at once, next() waits until a change is pushed or it is closed. */
function fakeDb() {
  type Watch = { pipeline: unknown[]; options: Record<string, unknown>; closed: boolean; push: (c: unknown) => void };
  const watches: Watch[] = [];
  const db = {
    collection: () => ({
      watch: (pipeline: unknown[], options: Record<string, unknown>) => {
        let wake: ((v: unknown) => void) | null = null;
        let fail: ((e: Error) => void) | null = null;
        const w: Watch = { pipeline, options, closed: false, push: (c) => { const f = wake; wake = null; f?.(c); } };
        watches.push(w);
        return {
          tryNext: async () => null,
          next: () => new Promise((ok, bad) => { wake = ok; fail = bad; }),
          close: async () => { w.closed = true; fail?.(new Error("ChangeStream is closed")); wake = null; },
        };
      },
    }),
  };
  return { db, watches };
}

const req = (path = "/api/stream", ip = "203.0.113.9", headers: Record<string, string> = {}) => {
  const ac = new AbortController();
  return { ac, request: new Request(`http://x${path}`, { headers: { "x-forwarded-for": ip, ...headers }, signal: ac.signal }) };
};
const settle = () => new Promise((ok) => setTimeout(ok, 20));

describe("GET /api/stream", () => {
  beforeEach(() => { mongo.db = null; });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("answers 503 (so the page keeps polling) when MongoDB is not configured", async () => {
    const r = await GET(req("/api/stream", "203.0.113.1").request);
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await r.json()).error).toMatch(/not configured/);
    expect(activeStreams()).toBe(0); // the refused request released its slot
  });

  it("the real getDb returns null without MONGODB_URI (the case the 503 above stands in for)", async () => {
    vi.stubEnv("MONGODB_URI", "");
    const real = await vi.importActual<typeof import("@/server/db/mongo")>("@/server/db/mongo");
    expect(await real.getDb()).toBeNull();
  });

  it("rejects a malformed deal filter", async () => {
    expect((await GET(req("/api/stream?deal=../../etc", "203.0.113.2").request)).status).toBe(400);
  });

  it("caps open streams per instance, and frees a slot when a viewer leaves", async () => {
    const { db, watches } = fakeDb();
    mongo.db = db;
    const open = [];
    for (let i = 0; i < MAX_STREAMS; i++) {
      const q = req("/api/stream", `198.51.100.${i}`);
      const r = await GET(q.request);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/^text\/event-stream/);
      expect(r.headers.get("cache-control")).toMatch(/no-store/);
      open.push({ ...q, r });
    }
    expect(activeStreams()).toBe(MAX_STREAMS);
    const over = await GET(req("/api/stream", "198.51.100.200").request);
    expect(over.status).toBe(503);
    expect((await over.json()).fallback).toMatch(/poll/);

    open[0].ac.abort(); // the browser tab closed
    await settle();
    expect(watches[0].closed).toBe(true);
    expect(activeStreams()).toBe(MAX_STREAMS - 1);
    const again = await GET(req("/api/stream", "198.51.100.201").request);
    expect(again.status).toBe(200);
    await again.body?.cancel();
    for (const o of open.slice(1)) await o.r.body?.cancel();
    await settle();
    expect(activeStreams()).toBe(0);
  });

  it("streams ready, then a sanitized deal frame with a resume id, and filters by deal", async () => {
    const { db, watches } = fakeDb();
    mongo.db = db;
    const { request } = req("/api/stream?deal=shs-0123abcd-4567", "198.51.100.50", { "last-event-id": '{"_data":"82AB"}' });
    const r = await GET(request);
    expect(r.status).toBe(200);
    const w = watches[0];
    expect(w.options.fullDocument).toBe("updateLookup");
    expect(w.options.resumeAfter).toEqual({ _data: "82AB" });
    const [match, project] = w.pipeline as [{ $match: Record<string, unknown> }, { $project: Record<string, unknown> }];
    expect(match.$match["documentKey._id"]).toBe(record()._id); // narrowed to the one deal in ?deal=
    expect(project.$project["fullDocument.authId"]).toBe(0);

    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    const first = dec.decode((await reader.read()).value);
    expect(first).toContain("event: ready");
    await settle();
    w.push(change(record())); // a change arrives on the fake stream
    const frame = dec.decode((await reader.read()).value);
    expect(frame).toContain("event: deal");
    expect(frame).toContain('id: {"_data":"8266F0A1B2000000012B"}');
    expect(frame).not.toContain("authId");
    expect(frame).not.toContain("7412345678901234567890");
    await reader.cancel();
    await settle();
    expect(w.closed).toBe(true);
    expect(activeStreams()).toBe(0);
  });
});

describe("the change-event serializer", () => {
  it("never includes authId or sweepAttemptAt, and hides listing text we did not write", () => {
    const frame = dealFrame(change(record()))!;
    expect(frame).toMatch(/^id: \{"_data":"8266F0A1B2000000012B"\}\nevent: deal\ndata: /);
    expect(frame.endsWith("\n\n")).toBe(true);
    const data = JSON.parse(frame.split("\ndata: ")[1]);
    expect(data).not.toHaveProperty("authId");
    expect(data).not.toHaveProperty("sweepAttemptAt");
    expect(data).not.toHaveProperty("_id");
    expect(frame).not.toContain("7412345678901234567890");
    expect(frame).not.toContain("404-555-0101");
    expect(data.listing).toBe("A listing");
    expect(data.dealId).toBe("shs-0123abcd-4567");
    expect(data.status).toBe("HELD");
  });

  it("drops fields that are not on the allowlist, even ones added later", () => {
    const data = boardDeal({ ...record(), visaRef: "secret" } as DealRecord & { visaRef: string });
    expect(Object.keys(data).sort()).toEqual(["agent", "amountUsd", "card", "createdAt", "dealId", "events", "listing", "status", "updatedAt"]);
  });

  it("keeps listing text we wrote verbatim", () => {
    const known = DEMO_TABLE[0].label;
    expect(JSON.parse(dealFrame(change(record({ listing: known })))!.split("\ndata: ")[1]).listing).toBe(known);
  });

  it("sends nothing for deletes or a missing document", () => {
    expect(dealFrame(change(record(), "delete"))).toBeNull();
    expect(dealFrame(change(undefined, "update"))).toBeNull();
  });

  it("accepts only a well-formed resume token", () => {
    expect(parseResume('{"_data":"82AB"}')).toEqual({ _data: "82AB" });
    expect(parseResume(null)).toBeUndefined();
    expect(parseResume("not json")).toBeUndefined();
    expect(parseResume('{"_data":1}')).toBeUndefined();
    expect(parseResume('{"_data":"a","$where":"x"}')).toBeUndefined();
    expect(parseResume("x".repeat(3000))).toBeUndefined();
  });
});
