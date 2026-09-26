import { describe, it, expect, vi, beforeAll } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { fakeDb } from "./fixtures/fakeDb";
import { issueDealToken } from "@/server/deals/token";

const fake = fakeDb();
vi.mock("@/server/db/mongo", () => ({ getDb: async () => fake.db }));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const VISA = "visa-secret-for-tests";
beforeAll(() => {
  Object.assign(process.env, { VISA_MERCHANT_ID: "m", VISA_KEY_ID: "k", VISA_SECRET_KEY: VISA, RECALL_CALL_VONAGE_APPLICATION_ID: "app", RECALL_CALL_VONAGE_PRIVATE_KEY: privateKey,
    RECALL_CALL_FROM_NUMBER: "+14045550100", RECALL_CALL_SECRET: "call-secret-for-tests", PUBLIC_BASE_URL: "https://lullabuy.example", MONGODB_URI: "mongodb://fake" });
});
const post = (url: string, body: unknown, ip: string) => new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });

describe("opt-in and status routes", () => {
  it("binds the number to the deal in the token, refuses bad input, and returns only the last 4", async () => {
    const { POST: optin } = await import("@/app/api/recall-call/optin/route");
    const { POST: status } = await import("@/app/api/recall-call/status/route");
    const token = issueDealToken(VISA, { dealId: "shs-route", authId: "a", amountUsd: 42 });
    expect((await optin(post("http://x", { token: "forged.token", phone: "4045550123" }, "1.1.1.1"))).status).toBe(403);
    expect((await optin(post("http://x", { token, phone: "+44 20 7946 0000" }, "1.1.1.2"))).status).toBe(400);
    const ok = await optin(post("http://x", { token, phone: "(404) 555-0123" }, "1.1.1.3"));
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j).toEqual({ optedIn: true, last4: "0123" });
    const stored = JSON.stringify(fake.docs("recall_optins"));
    expect(stored).not.toContain("4045550123");
    expect(fake.docs("recall_optins")[0]._id).toBe("shs-route");
    const s = await (await status(post("http://x", { token }, "1.1.1.4"))).json();
    expect(s).toEqual({ optedIn: true, last4: "0123", calls: [] });
    expect(JSON.stringify(s)).not.toContain("4045550123");
  });
  it("rate-limits the opt-in endpoint per IP", async () => {
    const { POST: optin } = await import("@/app/api/recall-call/optin/route");
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await optin(post("http://x", { token: "bad", phone: "4045550123" }, "9.9.9.9"))).status);
    expect(codes.slice(0, 6).every((c) => c === 403)).toBe(true);
    expect(codes.slice(6)).toEqual([429, 429]);
  });
});

describe("Vonage callbacks", () => {
  it("DTMF 1 replays the verdict; anything else, or a forged ticket, does not", async () => {
    const { POST: input } = await import("@/app/api/recall-call/input/route");
    const { signTicket } = await import("@/server/call/config");
    await fake.db.collection("recall_calls").insertOne({ _id: "shs-route:reversed", dealId: "shs-route", status: "placed", mode: "talk", text: "This is Lullabuy." } as never);
    const c = encodeURIComponent(signTicket("call-secret-for-tests", { k: "shs-route:reversed", p: "input", n: 0 }));
    const again = await (await input(post(`http://x/api/recall-call/input?c=${c}`, { dtmf: { digits: "1" } }, "2.2.2.2"))).json();
    expect(again[0]).toEqual({ action: "talk", text: "This is Lullabuy.", language: "en-US" });
    expect(again.at(-1).action).toBe("input");
    const bye = await (await input(post(`http://x/api/recall-call/input?c=${c}`, { dtmf: { digits: "2" } }, "2.2.2.2"))).json();
    expect(bye).toEqual([{ action: "talk", text: "Goodbye.", language: "en-US" }]);
    expect((await input(post("http://x/api/recall-call/input?c=forged", { dtmf: { digits: "1" } }, "2.2.2.2"))).status).toBe(403);
  });
});
