import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { parseUsPhone, sealPhone, openPhone, phoneHash, last4 } from "@/server/call/phone";
import { buildNcco, callScript, MAX_REPLAYS, spokenAmount, spokenItem } from "@/server/call/ncco";
import { isTeamNumber, normalizePem, perNumberCapFor, recallCallConfig, signTicket, verifyTicket, PER_NUMBER_DAILY_CAP, TEAM_NUMBER_DAILY_CAP, type RecallCallConfig } from "@/server/call/config";
import { placeCall, vonageJwt } from "@/server/call/vonage";
import { recallCall, runPendingCalls, queueRecallCall, CALL_MAX_MS } from "@/server/call/trigger";
import { callAfterReversal } from "@/server/call/pickup";
import { counter, dayKey, ensureIndexes, getOptIn, saveOptIn, takeSlot } from "@/server/call/store";
import { checkCode, codeNcco, startCodeCall, VERIFY_CALLS_PER_NUMBER } from "@/server/call/verify";
import { integrationStatus } from "@/server/env";
import { boardDeal, pub, type DealRecord } from "@/server/deals/store";
import { summarize } from "@/server/deals/trust";
import { dealFrame } from "@/server/deals/stream";
import { DEMO_TABLE } from "@/core/demoTable";
import { fakeDb } from "./fixtures/fakeDb";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const SECRET = "test-recall-secret-not-real";
const cfg = (over: Partial<RecallCallConfig> = {}): RecallCallConfig => ({
  applicationId: "00000000-0000-4000-8000-000000000000", privateKey, from: "+14045552300", secret: SECRET,
  baseUrl: "https://lullabuy.example", dailyCap: 20, perNumberCap: PER_NUMBER_DAILY_CAP, ...over,
});
const PHONE = "+14045552368";

/** A Vonage mock that answers 201 with a uuid and records every request body. */
function vonageMock() {
  const bodies: Record<string, unknown>[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.nexmo.com/v1/calls");
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ uuid: `call-${bodies.length}`, status: "started" }), { status: 201 });
  });
  return { f: f as unknown as typeof fetch, bodies, calls: () => f.mock.calls.length };
}

async function seed(db: ReturnType<typeof fakeDb>, dealId: string, phone = PHONE, listing = DEMO_TABLE[0].label) {
  await db.db.collection("deals").insertOne({ _id: dealId, listing, amountUsd: 42, status: "REVERSED", card: "sandbox-test-card", agent: null,
    authId: "visa-auth-1", createdAt: "2026-09-26T20:00:00.000Z", updatedAt: "2026-09-26T20:00:00.000Z", events: [{ at: "2026-09-26T20:00:00.000Z", status: "HELD", note: "held" }] } as never);
  await saveOptIn(db.db, { _id: dealId, sealed: sealPhone(SECRET, phone), hash: phoneHash(SECRET, phone), last4: last4(phone) });
}
const reversed = { kind: "reversed" as const, verdict: "RECALL_MATCH" as const, recallNumber: "26-061" };

describe("US phone validation (E.164)", () => {
  it("normalizes common US spellings", () => {
    for (const s of ["(404) 555-2368", "404-555-2368", "404.555.2368", "4045552368", "14045552368", "+1 404 555 2368"]) expect(parseUsPhone(s)).toBe(PHONE);
  });
  it("refuses everything that is not a callable US number", () => {
    for (const s of ["+44 20 7946 0000", "+52 55 1234 5678", "123-456-7890", "404-155-0123", "911-555-2368", "404-911-0123", "900-555-2368", "976-555-2368",
      "404555012", "404555236845", "404-555-01a3", "", "   ", "x".repeat(50)]) expect(parseUsPhone(s)).toBeNull();
    expect(parseUsPhone(4045552368 as unknown)).toBeNull();
  });
  it("region is US exactly: Canada, the Caribbean and the territories are refused", () => {
    for (const s of ["416-555-2368", "+1 604 555 2368", "876-555-2368", "242-555-2368", "787-555-2368", "671-555-2368", "684-733-1234"]) expect(parseUsPhone(s)).toBeNull();
    expect(parseUsPhone("212-555-2368")).toBe("+12125552368");
  });
  it("refuses premium and service numbers in the area code and the exchange, N11, toll-free and 555-01XX fiction", () => {
    for (const s of ["900-555-2368", "976-555-2368", "404-900-2368", "404-976-2368", "404-411-2368", "404-911-2368", "411-555-2368", "311-555-2368",
      "800-555-2368", "888-555-2368", "404-555-0100", "404-555-0123", "404-555-0199"]) expect(parseUsPhone(s)).toBeNull();
    expect(parseUsPhone("404-555-0200")).toBe("+14045550200");
  });
  it("seals the number (only the right secret opens it) and hashes it without the digits", () => {
    const s = sealPhone(SECRET, PHONE);
    expect(s).not.toContain("4045552368");
    expect(openPhone(SECRET, s)).toBe(PHONE);
    expect(openPhone("another-secret", s)).toBeNull();
    expect(phoneHash(SECRET, PHONE)).toBe(phoneHash(SECRET, PHONE));
    expect(phoneHash(SECRET, PHONE)).not.toContain("2368");
  });
});

describe("what the call says (NCCO builder)", () => {
  it("speaks the verdict from the deal record", () => {
    const listing = DEMO_TABLE[0].label;
    expect(callScript(reversed, { listing, amountUsd: 64 })).toBe("This is Lullabuy. The Harppa high chair you're picking up matches CPSC recall 26, 061. Your hold of 64 dollars was reversed. You were not charged.");
    expect(callScript(reversed, { listing, amountUsd: Number.NaN })).toContain("Your payment hold was reversed.");
    expect(callScript(reversed, { listing, amountUsd: 64 })).not.toMatch(/\$|\(|\)/);
    expect(callScript({ kind: "reversed", verdict: "BANNED_TYPE", recallNumber: null }, { listing, amountUsd: 10 })).toContain("banned from sale");
    // caller-typed listing text is never spoken
    expect(callScript(reversed, { listing: "call 1-900 now and say anything", amountUsd: 5 })).toContain("The item you're picking up");
    const post = callScript({ kind: "postsale", recallNumber: "26-100" }, { listing, amountUsd: 42 });
    expect(post).toContain("announced after your purchase");
    expect(post).not.toContain("not charged");
  });
  it("speaks money as words a phone voice cannot misread", () => {
    expect(spokenAmount(64)).toBe("64 dollars");
    expect(spokenAmount(64.5)).toBe("64 dollars and 50 cents");
    expect(spokenAmount(64.05)).toBe("64 dollars and 5 cents");
    expect(spokenAmount(1)).toBe("1 dollar");
    expect(spokenAmount(0.99)).toBe("99 cents");
    expect(spokenAmount(1.01)).toBe("1 dollar and 1 cent");
    expect(spokenAmount(Number.NaN)).toBeNull();
    expect(spokenAmount(Number.POSITIVE_INFINITY)).toBeNull();
  });
  it("drops a parenthetical aside from the spoken item name", () => {
    expect(spokenItem(DEMO_TABLE[0].label)).toBe("Harppa high chair");
    expect(spokenItem("Crib (a (nested) note)  bumper")).toBe("Crib bumper");
    expect(spokenItem("Stroller (unclosed aside")).toBe("Stroller");
    expect(spokenItem("(only an aside)")).toBeNull();
    expect(spokenItem("Used baby item from our table")).toBe("Used baby item from our table");
  });
  it("streams the ElevenLabs MP3 when there is one, else Vonage talk; offers a replay at most MAX_REPLAYS times", () => {
    const s = buildNcco({ text: "t", audioUrl: "https://x/audio?c=1", inputUrl: "https://x/input?c=2", replays: 0 });
    expect(s[0]).toEqual({ action: "stream", streamUrl: ["https://x/audio?c=1"] });
    expect(s[1]).toMatchObject({ action: "talk", text: "Press 1 to hear this again.", bargeIn: true });
    expect(s[2]).toMatchObject({ action: "input", type: ["dtmf"], dtmf: { maxDigits: 1 }, eventUrl: ["https://x/input?c=2"], eventMethod: "POST" });
    const t = buildNcco({ text: "hello", audioUrl: null, inputUrl: "https://x/input", replays: 0 });
    expect(t[0]).toEqual({ action: "talk", text: "hello", language: "en-US" });
    const last = buildNcco({ text: "hello", audioUrl: null, inputUrl: "https://x/input", replays: MAX_REPLAYS });
    expect(last.map((a) => a.action)).toEqual(["talk", "talk"]);
    expect(last.some((a) => a.action === "input")).toBe(false);
  });
});

describe("Vonage request", () => {
  it("signs an RS256 application JWT the public key verifies", () => {
    const jwt = vonageJwt("app-1", privateKey, 1_700_000_000_000);
    const [h, b, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(b, "base64url").toString())).toMatchObject({ application_id: "app-1", iat: 1_700_000_000, exp: 1_700_000_300 });
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
  it("posts an inline NCCO from the owned number, digits only", async () => {
    const v = vonageMock();
    const r = await placeCall({ applicationId: "app-1", privateKey, to: PHONE, from: "+14045552300", ncco: [{ action: "talk", text: "x" }], eventUrl: "https://x/event" }, v.f);
    expect(r).toEqual({ ok: true, uuid: "call-1" });
    expect(v.bodies[0]).toMatchObject({ to: [{ type: "phone", number: "14045552368" }], from: { type: "phone", number: "14045552300" }, ncco: [{ action: "talk", text: "x" }], event_url: ["https://x/event"] });
  });
  it("gives up on a Vonage that hangs, and reports an HTTP error as a failure", async () => {
    const hang = (() => new Promise<Response>(() => {})) as typeof fetch;
    const t0 = Date.now();
    expect(await placeCall({ applicationId: "a", privateKey, to: PHONE, from: PHONE, ncco: [], eventUrl: "e" }, hang, 50)).toMatchObject({ ok: false });
    expect(Date.now() - t0).toBeLessThan(1000);
    const bad = (async () => new Response("{\"title\":\"Forbidden\"}", { status: 403 })) as typeof fetch;
    expect(await placeCall({ applicationId: "a", privateKey, to: PHONE, from: PHONE, ncco: [], eventUrl: "e" }, bad)).toMatchObject({ ok: false, error: expect.stringContaining("403") });
  });
});

describe("recall call gates", () => {
  const deps = (db: ReturnType<typeof fakeDb>, f: typeof fetch, over: Partial<RecallCallConfig> = {}) => ({ db: db.db, cfg: cfg(over), fetchImpl: f, elevenKey: null });

  it("places exactly one call per deal per reason, however many race", async () => {
    const db = fakeDb(); await seed(db, "shs-a");
    const v = vonageMock();
    const out = await Promise.all(Array.from({ length: 12 }, () => recallCall("shs-a", reversed, deps(db, v.f))));
    expect(out.filter((o) => o.state === "placed")).toHaveLength(1);
    expect(out.filter((o) => o.state === "already")).toHaveLength(11);
    expect(v.calls()).toBe(1);
    // a different reason (a later post-sale recall) is its own single call
    expect((await recallCall("shs-a", { kind: "postsale", recallNumber: "26-100" }, deps(db, v.f))).state).toBe("placed");
    expect(v.calls()).toBe(2);
  });

  it("the daily cap is atomic under concurrency and fails closed", async () => {
    const db = fakeDb();
    const nums = ["+14045552301", "+14045552302", "+14045552303", "+14045552304", "+14045552305"];
    for (const [i, n] of nums.entries()) await seed(db, `shs-d${i}`, n);
    const v = vonageMock();
    const out = await Promise.all(nums.map((_, i) => recallCall(`shs-d${i}`, reversed, deps(db, v.f, { dailyCap: 2 }))));
    expect(out.filter((o) => o.state === "placed")).toHaveLength(2);
    expect(out.filter((o) => o.state === "capped-daily")).toHaveLength(3);
    expect(v.calls()).toBe(2);
    // a cap of 0, or a counter store that errors, means no call at all
    const db2 = fakeDb(); await seed(db2, "shs-z");
    expect((await recallCall("shs-z", reversed, deps(db2, v.f, { dailyCap: 0 }))).state).toBe("capped-daily");
    const db3 = fakeDb({ failing: ["recall_call_counters"] }); await seed(db3, "shs-y");
    expect((await recallCall("shs-y", reversed, deps(db3, v.f))).state).toBe("capped-number") // the first cap it checks is down: no call;
    expect(await takeSlot(db3.db, "day:x", 5)).toBe(false);
    expect(v.calls()).toBe(2);
  });

  it("one number gets at most PER_NUMBER_DAILY_CAP (6) calls a day across deals, and the next ones are refused", async () => {
    expect(PER_NUMBER_DAILY_CAP).toBe(6);
    const n = PER_NUMBER_DAILY_CAP + 2;
    const db = fakeDb();
    for (let i = 0; i < n; i++) await seed(db, `shs-n${i}`);
    const v = vonageMock();
    const out = await Promise.all(Array.from({ length: n }, (_, i) => recallCall(`shs-n${i}`, reversed, deps(db, v.f))));
    expect(out.filter((o) => o.state === "placed")).toHaveLength(PER_NUMBER_DAILY_CAP);
    expect(out.filter((o) => o.state === "capped-number")).toHaveLength(2);
    expect(v.calls()).toBe(PER_NUMBER_DAILY_CAP);
    // at the cap, one more attempt on a fresh deal is still refused and places no call
    await seed(db, "shs-n-late");
    expect((await recallCall("shs-n-late", reversed, deps(db, v.f))).state).toBe("capped-number");
    expect(v.calls()).toBe(PER_NUMBER_DAILY_CAP);
  });

  it("never calls a number that did not opt in on the same deal, and does nothing without Atlas or config", async () => {
    const db = fakeDb(); await seed(db, "shs-owner");
    await db.db.collection("deals").insertOne({ _id: "shs-other", listing: "x", amountUsd: 1, status: "REVERSED", events: [] } as never);
    const v = vonageMock();
    expect((await recallCall("shs-other", reversed, deps(db, v.f))).state).toBe("no-optin");
    expect((await recallCall("shs-owner", reversed, { db: null, cfg: cfg(), fetchImpl: v.f, elevenKey: null })).state).toBe("no-db");
    expect((await recallCall("shs-owner", reversed, { db: db.db, cfg: null, fetchImpl: v.f, elevenKey: null })).state).toBe("not-configured");
    const broken = fakeDb({ failing: ["recall_optins"] }); await seed(fakeDb(), "shs-q");
    expect((await recallCall("shs-q", reversed, { db: broken.db, cfg: cfg(), fetchImpl: v.f, elevenKey: null })).state).toBe("no-optin");
    expect(v.calls()).toBe(0);
  });

  it("uses the ElevenLabs MP3 when TTS answers, and Vonage talk when it fails", async () => {
    const db = fakeDb(); await seed(db, "shs-s"); await seed(db, "shs-t", "+14045552399");
    const bodies: Record<string, unknown>[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("elevenlabs")) return new Response(new Uint8Array(4000), { status: 200 });
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ uuid: "u" }), { status: 201 });
    }) as typeof fetch;
    const a = await recallCall("shs-s", reversed, { db: db.db, cfg: cfg(), fetchImpl: f, elevenKey: "k" });
    expect(a).toMatchObject({ state: "placed", mode: "stream" });
    const ncco = bodies[0].ncco as { action: string; streamUrl?: string[] }[];
    expect(ncco[0].streamUrl?.[0]).toMatch(/^https:\/\/lullabuy\.example\/api\/recall-call\/audio\?c=/);
    const failTts = (async (url: string | URL | Request, init?: RequestInit) => (String(url).includes("elevenlabs") ? new Response("no", { status: 500 }) : f(url, init))) as typeof fetch;
    expect(await recallCall("shs-t", reversed, { db: db.db, cfg: cfg(), fetchImpl: failTts, elevenKey: "k" })).toMatchObject({ state: "placed", mode: "talk" });
    expect((bodies[1].ncco as { action: string }[])[0].action).toBe("talk");
  });

  it("a Vonage that hangs does not hang the trigger, and the claim is not retried into a second call", async () => {
    const db = fakeDb(); await seed(db, "shs-h");
    const hang = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true, advanceTimeDelta: 50 });
    try {
      const p = recallCall("shs-h", reversed, { db: db.db, cfg: cfg(), fetchImpl: hang, elevenKey: null });
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await p).toMatchObject({ state: "failed" });
    } finally {
      vi.useRealTimers();
    }
    expect((await recallCall("shs-h", reversed, { db: db.db, cfg: cfg(), fetchImpl: hang, elevenKey: null })).state).toBe("already");
  });
});

describe("the phone number never reaches a public surface", () => {
  it("pub(), boardDeal(), the SSE frame and the trust console carry no digits of it", async () => {
    const db = fakeDb(); await seed(db, "shs-p");
    const v = vonageMock();
    expect((await recallCall("shs-p", reversed, { db: db.db, cfg: cfg(), fetchImpl: v.f, elevenKey: null })).state).toBe("placed");
    const deal = db.docs("deals")[0] as unknown as DealRecord;
    expect(deal.events.at(-1)?.note).toContain("phoned the buyer");
    const surfaces = [
      JSON.stringify(pub(deal)), JSON.stringify(boardDeal(deal)),
      dealFrame({ operationType: "update", _id: { _data: "x" }, fullDocument: deal } as never) ?? "",
      JSON.stringify(summarize([deal as never])),
    ];
    for (const s of surfaces) {
      expect(s).not.toMatch(/4045552368|404.?555.?2368/);
      expect(s).not.toContain("2368");
      expect(s).not.toContain(phoneHash(SECRET, PHONE));
    }
    // and nothing about the number was written onto the deal document itself
    expect(Object.keys(deal).sort()).toEqual(["_id", "agent", "amountUsd", "authId", "card", "createdAt", "events", "listing", "status", "updatedAt"]);
  });
});

describe("after a reversal at pickup", () => {
  it("waits for the settlement on the record, then calls", async () => {
    const db = fakeDb(); await seed(db, "shs-r");
    const v = vonageMock();
    const out = await callAfterReversal("shs-r", { kind: "RECALL_MATCH", reason: "r", recall: { recallNumber: "26-061" } } as never, { db: db.db, cfg: cfg(), fetchImpl: v.f, elevenKey: null, waitMs: 500 });
    expect(out.state).toBe("placed");
    const notes = (db.docs("deals")[0].events as { note: string }[]).map((e) => e.note);
    expect(notes.at(-1)).toContain("phoned the buyer");
  });
  it("a verdict that did not reverse never calls", async () => {
    const v = vonageMock();
    expect((await callAfterReversal("shs-r", { kind: "NO_MATCH", reason: "r" } as never, { db: fakeDb().db, cfg: cfg(), fetchImpl: v.f })).state).toBe("no-optin");
    expect(v.calls()).toBe(0);
  });
});

describe("config and health (wired-or-cut)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const full = { RECALL_CALL_VONAGE_APPLICATION_ID: "a", RECALL_CALL_VONAGE_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"), RECALL_CALL_FROM_NUMBER: "404-555-2300",
    RECALL_CALL_SECRET: "s", PUBLIC_BASE_URL: "https://lullabuy.example/", MONGODB_URI: "mongodb://x" };
  it("recallCall is live only when every variable is present", () => {
    expect(integrationStatus(full).recallCall).toBe(true);
    for (const k of Object.keys(full)) expect(integrationStatus({ ...full, [k]: "" }).recallCall).toBe(false);
    expect(JSON.stringify(integrationStatus(full))).not.toContain("BEGIN");
  });
  it("parses the key, number, base URL and cap", () => {
    const c = recallCallConfig(full)!;
    expect(c.privateKey).toBe(privateKey.trim()); // the escaped \n form is turned back into real line breaks
    expect(c.from).toBe("+14045552300");
    expect(c.baseUrl).toBe("https://lullabuy.example");
    expect(c.dailyCap).toBe(60);
    expect(c.perNumberCap).toBe(PER_NUMBER_DAILY_CAP);
    expect(recallCallConfig({ ...full, RECALL_CALL_DAILY_CAP: "3" })!.dailyCap).toBe(3);
    expect(recallCallConfig({ ...full, RECALL_CALL_DAILY_CAP: "9999" })!.dailyCap).toBe(500);
    expect(recallCallConfig({ ...full, RECALL_CALL_DAILY_CAP: "abc" })!.dailyCap).toBe(60);
    expect(recallCallConfig({ ...full, PUBLIC_BASE_URL: "http://lullabuy.example" })).toBeNull();
    expect(recallCallConfig({ ...full, RECALL_CALL_FROM_NUMBER: "+44 20 7946 0000" })).toBeNull();
    expect(normalizePem(Buffer.from(privateKey).toString("base64"))).toBe(privateKey.trim());
  });
  it("team numbers get the team caps, everyone else keeps the normal ones", () => {
    const c = recallCallConfig({ ...full, RECALL_CALL_TEAM_NUMBERS: "404-555-0101, not a number, +1 (678) 555-0199" })!;
    const team = phoneHash("s", "+14045550101"), team2 = phoneHash("s", "+16785550199"), other = phoneHash("s", "+14045550102");
    expect(perNumberCapFor(c, team)).toBe(TEAM_NUMBER_DAILY_CAP);
    expect(perNumberCapFor(c, team2)).toBe(TEAM_NUMBER_DAILY_CAP);
    expect(perNumberCapFor(c, other)).toBe(PER_NUMBER_DAILY_CAP);
    expect(isTeamNumber(recallCallConfig(full)!, team)).toBe(false);
    expect(c.dailyCap).toBe(60); // the whole-deployment cap still bounds team numbers
  });
  it("callback tickets are purpose-bound and expire", () => {
    const t = signTicket(SECRET, { k: "d:reversed", p: "audio" }, 1000, 0);
    expect(verifyTicket(SECRET, t, "audio", 500)?.k).toBe("d:reversed");
    expect(verifyTicket(SECRET, t, "input", 500)).toBeNull();
    expect(verifyTicket(SECRET, t, "audio", 2000)).toBeNull();
    expect(verifyTicket("other", t, "audio", 500)).toBeNull();
    expect(verifyTicket(SECRET, `${t}x`, "audio", 500)).toBeNull();
  });
});

describe("proof of phone control before an opt-in is active", () => {
  const codeFrom = (body: Record<string, unknown>) => ((body.ncco as { text: string }[])[0].text.match(/code is ([\d, ]+)\./)?.[1] ?? "").replace(/\D/g, "");

  it("calls the number with a 4-digit code; only that code, on that deal, turns the opt-in on", async () => {
    const db = fakeDb();
    const v = vonageMock();
    expect((await startCodeCall(db.db, cfg(), "shs-v", PHONE, { fetchImpl: v.f })).state).toBe("calling");
    expect(codeNcco("4721")[0].text).toBe("Your Lullabuy code is 4, 7, 2, 1. Again, your code is 4, 7, 2, 1. Goodbye.");
    const code = codeFrom(v.bodies[0]);
    expect(code).toMatch(/^\d{4}$/);
    expect(v.bodies[0].to).toEqual([{ type: "phone", number: "14045552368" }]);
    // the code is stored hashed, and nothing is active yet
    expect(JSON.stringify(db.docs("recall_verifications"))).not.toContain(`"${code}"`);
    expect(await getOptIn(db.db, "shs-v")).toBeNull();
    expect((await recallCall("shs-v", reversed, { db: db.db, cfg: cfg(), fetchImpl: v.f, elevenKey: null })).state).toBe("no-optin");
    // the right code on ANOTHER deal does nothing
    expect((await checkCode(db.db, cfg(), "shs-other", code)).state).toBe("expired");
    const wrong = code === "0000" ? "1111" : "0000";
    expect((await checkCode(db.db, cfg(), "shs-v", wrong)).state).toBe("wrong");
    expect(await checkCode(db.db, cfg(), "shs-v", code)).toEqual({ state: "verified", last4: "2368" });
    expect((await getOptIn(db.db, "shs-v"))?.last4).toBe("2368");
  });

  it("3 attempts, then the code is dead; codes expire after 10 minutes", async () => {
    const db = fakeDb();
    const v = vonageMock();
    await startCodeCall(db.db, cfg(), "shs-a3", PHONE, { fetchImpl: v.f, code: "1234" });
    for (let i = 0; i < 3; i++) expect((await checkCode(db.db, cfg(), "shs-a3", "9999")).state).toBe("wrong");
    expect((await checkCode(db.db, cfg(), "shs-a3", "1234")).state).toBe("expired");
    const t0 = Date.now();
    await startCodeCall(db.db, cfg(), "shs-ttl", "+14045552369", { fetchImpl: v.f, code: "1234", now: t0 });
    expect((await checkCode(db.db, cfg(), "shs-ttl", "1234", t0 + 11 * 60_000)).state).toBe("expired");
  });

  it("one code call in flight per deal, and at most 4 code calls per number per day", async () => {
    expect(VERIFY_CALLS_PER_NUMBER).toBe(4);
    const db = fakeDb();
    const v = vonageMock();
    const both = await Promise.all([startCodeCall(db.db, cfg(), "shs-f", PHONE, { fetchImpl: v.f }), startCodeCall(db.db, cfg(), "shs-f", PHONE, { fetchImpl: v.f })]);
    expect(both.map((r) => r.state).sort()).toEqual(["calling", "in-flight"]);
    for (const id of ["shs-g", "shs-g2", "shs-g3"]) expect((await startCodeCall(db.db, cfg(), id, PHONE, { fetchImpl: v.f })).state).toBe("calling");
    expect((await startCodeCall(db.db, cfg(), "shs-h", PHONE, { fetchImpl: v.f })).state).toBe("capped-verify");
    expect(v.calls()).toBe(4);
    const day = dayKey();
    // the refused fifth attempt spent nothing; each code call spent the number's and the day's budget
    expect(await counter(db.db, `vnum:${phoneHash(SECRET, PHONE)}:${day}`)).toBe(4);
    expect(await counter(db.db, `num:${phoneHash(SECRET, PHONE)}:${day}`)).toBe(4);
    expect(await counter(db.db, `day:${day}`)).toBe(4);
  });
});

describe("cap order: a capped number never spends the shared daily budget", () => {
  it("per-number refusals leave the global count unchanged", async () => {
    // pins its own per-number cap (3) so the order is tested independently of PER_NUMBER_DAILY_CAP
    const db = fakeDb();
    for (let i = 0; i < 8; i++) await seed(db, `shs-c${i}`);
    const v = vonageMock();
    for (let i = 0; i < 8; i++) await recallCall(`shs-c${i}`, reversed, { db: db.db, cfg: cfg({ dailyCap: 5, perNumberCap: 3 }), fetchImpl: v.f, elevenKey: null });
    expect(v.calls()).toBe(3);
    expect(await counter(db.db, `day:${dayKey()}`)).toBe(3);
    // another number still gets its call: the 5 refused attempts did not use up the day
    await seed(db, "shs-other-number", "+14045552399");
    expect((await recallCall("shs-other-number", reversed, { db: db.db, cfg: cfg({ dailyCap: 5, perNumberCap: 3 }), fetchImpl: v.f, elevenKey: null })).state).toBe("placed");
  });
  it("a daily refusal gives the number's slot back", async () => {
    const db = fakeDb(); await seed(db, "shs-dd");
    const v = vonageMock();
    expect((await recallCall("shs-dd", reversed, { db: db.db, cfg: cfg({ dailyCap: 0 }), fetchImpl: v.f, elevenKey: null })).state).toBe("capped-daily");
    expect(await counter(db.db, `num:${phoneHash(SECRET, PHONE)}:${dayKey()}`)).toBe(0);
  });
});

describe("recall watch: queued calls run after the loop, in parallel, within the time left", () => {
  const slow = (ms: number) => (async () => { await new Promise((ok) => setTimeout(ok, ms)); return new Response(JSON.stringify({ uuid: "u" }), { status: 201 }); }) as unknown as typeof fetch;

  it("4 slow providers finish together, well inside the budget", async () => {
    const db = fakeDb();
    for (let i = 0; i < 4; i++) { await seed(db, `shs-w${i}`, `+1404555237${i}`); expect(await queueRecallCall(`shs-w${i}`, "26-100", { db: db.db, cfg: cfg() })).toBe(true); }
    expect(await queueRecallCall("shs-w0", "26-100", { db: db.db, cfg: cfg() })).toBe(false); // idempotent
    const t0 = Date.now();
    const r = await runPendingCalls(t0 + CALL_MAX_MS + 10_000, { db: db.db, cfg: cfg(), fetchImpl: slow(400), elevenKey: null });
    expect(Date.now() - t0).toBeLessThan(1500); // parallel: about one call's time, not four
    expect(r).toMatchObject({ started: 4, timedOut: false });
    expect(r.outcomes).toEqual(["placed", "placed", "placed", "placed"]);
    expect(db.docs("recall_calls").every((c) => c.status === "placed")).toBe(true);
  });

  it("with too little time left, nothing starts; the leftovers run on the next run, exactly once", async () => {
    const db = fakeDb(); await seed(db, "shs-late");
    await queueRecallCall("shs-late", "26-100", { db: db.db, cfg: cfg() });
    const v = vonageMock();
    const first = await runPendingCalls(Date.now() + 1000, { db: db.db, cfg: cfg(), fetchImpl: v.f, elevenKey: null });
    expect(first).toMatchObject({ started: 0, timedOut: true });
    expect(db.docs("recall_calls")[0].status).toBe("pending");
    await runPendingCalls(Date.now() + 60_000, { db: db.db, cfg: cfg(), fetchImpl: v.f, elevenKey: null });
    await runPendingCalls(Date.now() + 60_000, { db: db.db, cfg: cfg(), fetchImpl: v.f, elevenKey: null });
    expect(v.calls()).toBe(1);
  });

  it("an unverified deal is never queued", async () => {
    const db = fakeDb();
    expect(await queueRecallCall("shs-none", "26-100", { db: db.db, cfg: cfg() })).toBe(false);
    expect(db.docs("recall_calls")).toHaveLength(0);
  });
});

describe("TTL indexes before any phone write", () => {
  it("creates every TTL index before the first write, and refuses the write (fail closed) when it cannot", async () => {
    let fail = true;
    const db = fakeDb({ failIndex: () => fail });
    const opt = { _id: "shs-ttl-1", sealed: sealPhone(SECRET, PHONE), hash: phoneHash(SECRET, PHONE), last4: "2368" };
    expect(await saveOptIn(db.db, opt)).toBe(false);
    expect(db.docs("recall_optins")).toHaveLength(0);
    const v = vonageMock();
    expect((await startCodeCall(db.db, cfg(), "shs-ttl-1", PHONE, { fetchImpl: v.f })).state).toBe("no-db");
    expect(v.calls()).toBe(0);
    expect(db.docs("recall_verifications")).toHaveLength(0);
    // not marked ready after a failure: the next write retries the indexes
    fail = false;
    expect(await saveOptIn(db.db, opt)).toBe(true);
    expect([...new Set(db.indexes)].sort()).toEqual(["recall_call_counters", "recall_calls", "recall_optins", "recall_verifications"]);
    expect(await ensureIndexes(db.db)).toBe(true);
  });
});
