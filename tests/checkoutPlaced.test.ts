import { describe, it, expect, afterEach, vi } from "vitest";
import { POST } from "@/app/api/checkout/route";

// The shop's one-hold guard clears its pending marker ONLY on an explicit placed: false (Codex review round 3).
const post = (body: unknown, ip = `192.0.2.${Math.floor(Math.random() * 200)}`) =>
  POST(new Request("http://x/api/checkout", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) }));
const visaEnv = () => {
  vi.stubEnv("VISA_MERCHANT_ID", "unit_test_merchant");
  vi.stubEnv("VISA_KEY_ID", "00000000-0000-0000-0000-000000000000");
  vi.stubEnv("VISA_SECRET_KEY", Buffer.from("u".repeat(32)).toString("base64")); // built at runtime, not a credential
};
const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("checkout says explicitly when no hold was placed, and never claims it when a hold may exist", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("every refusal before Visa is called carries placed: false", async () => {
    const r = await post({});
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ placed: false });
  });

  it("over-authorization with a CONFIRMED release: placed false", async () => {
    visaEnv();
    const f = vi.fn()
      .mockResolvedValueOnce(reply(201, { id: "auth1", status: "AUTHORIZED", processorInformation: { responseCode: "00" }, orderInformation: { amountDetails: { authorizedAmount: "80.00" } } }))
      .mockResolvedValueOnce(reply(201, { id: "rev1", status: "REVERSED" }));
    vi.stubGlobal("fetch", f);
    const r = await post({ listing: "Harppa high chair", amountUsd: 64 });
    const j = await r.json();
    expect(r.status).toBe(502);
    expect(j.placed).toBe(false);
    expect(j.uncertain).toBeUndefined();
  });

  it("over-authorization whose release Visa did NOT confirm: uncertain, never placed false", async () => {
    visaEnv();
    const f = vi.fn()
      .mockResolvedValueOnce(reply(201, { id: "auth2", status: "AUTHORIZED", processorInformation: { responseCode: "00" }, orderInformation: { amountDetails: { authorizedAmount: "80.00" } } }))
      .mockResolvedValueOnce(reply(502, {}));
    vi.stubGlobal("fetch", f);
    const r = await post({ listing: "Harppa high chair", amountUsd: 64 });
    const j = await r.json();
    expect(r.status).toBe(502);
    expect(j.uncertain).toBe(true);
    expect(j.placed).toBeUndefined();
    expect(j.error).toMatch(/MAY remain/);
  });

  it("a PARTIAL_AUTHORIZED is released; placed false only when the release is confirmed", async () => {
    visaEnv();
    const partial = { id: "p1", status: "PARTIAL_AUTHORIZED", orderInformation: { amountDetails: { authorizedAmount: "30.00" } } };
    const f1 = vi.fn().mockResolvedValueOnce(reply(201, partial)).mockResolvedValueOnce(reply(201, { id: "r1", status: "REVERSED" }));
    vi.stubGlobal("fetch", f1);
    const ok = await (await post({ listing: "Crib", amountUsd: 64 })).json();
    expect(ok).toMatchObject({ placed: false });
    expect(JSON.parse(String((f1.mock.calls[1] as unknown as [string, RequestInit])[1].body)).reversalInformation.amountDetails.totalAmount).toBe("30.00");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply(201, partial)).mockResolvedValueOnce(reply(503, {})));
    const bad = await (await post({ listing: "Crib", amountUsd: 64 })).json();
    expect(bad).toMatchObject({ uncertain: true });
    expect(bad.placed).toBeUndefined();
  });

  it("asks Visa never to partially authorize", async () => {
    visaEnv();
    const f = vi.fn().mockResolvedValueOnce(reply(201, { id: "d0", status: "DECLINED" }));
    vi.stubGlobal("fetch", f);
    await post({ listing: "Crib", amountUsd: 50 });
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.processingInformation).toMatchObject({ capture: false, authorizationOptions: { partialAuthIndicator: false } });
  });

  it("an unreadable authorization reply is uncertain; a readable decline is placed false", async () => {
    visaEnv();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply(500, {})));
    const a = await (await post({ listing: "Crib", amountUsd: 50 })).json();
    expect(a).toMatchObject({ uncertain: true });
    expect(a.placed).toBeUndefined();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply(201, { id: "d1", status: "DECLINED", errorInformation: { reason: "EXPIRED_CARD" } })));
    const d = await (await post({ listing: "Crib", amountUsd: 50 })).json();
    expect(d).toMatchObject({ placed: false, uncertain: false });
  });
});
