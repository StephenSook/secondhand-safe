import { describe, it, expect, afterEach, vi } from "vitest";
import { simulateRecall, parseHypothetical, recheckSales, type Sale } from "@/server/watch/recheck";
import { parseSubscription } from "@/server/watch/push";
import { POST as simulate } from "@/app/api/watch/simulate/route";
import { POST as subscribe } from "@/app/api/watch/subscribe/route";
import { GET as cronWatch } from "@/app/api/cron/watch/route";

const sale = (id: string, model: string | null, batch: string | null = null): Sale => ({ _id: id, listing: "Harppa high chair (table prop with the printed recall label)", label: { model, batch, date: null, upc: null } });

describe("recall watch: which real sales a recall would catch", () => {
  const sales = [sale("a", "BHC001", "202408"), sale("b", "bhc-001", null), sale("c", "BHC001", "202511"), sale("d", "XYZ9999"), sale("e", null)];
  it("matches the model with the matcher's folding (O/0, I/1, punctuation)", () => {
    expect(simulateRecall(sales, { model: "BHCOO1", batches: [] }).map((h) => h.dealId)).toEqual(["a", "b", "c"]);
  });
  it("with recalled batches: a different batch is excluded, a missing batch means read the label, never clear", () => {
    const hits = simulateRecall(sales, { model: "BHC001", batches: ["202408"] });
    expect(hits.map((h) => h.dealId)).toEqual(["a", "b"]);
    expect(hits.find((h) => h.dealId === "b")?.batchCheck).toMatch(/read it/);
  });
  it("needs a real model number", () => {
    expect(parseHypothetical({ model: "ab" })).toBeNull();
    expect(parseHypothetical({ model: "BHC001", batch: "202408, 202409" })).toEqual({ model: "BHC001", batches: ["202408", "202409"] });
  });
  it("the real daily path uses the shipped recall index and skips a sale already flagged for that recall", () => {
    const hits = recheckSales([sale("a", "BHC001", "202408"), sale("z", "XYZ9999")]);
    expect(hits.map((h) => [h.dealId, h.recallNumber])).toEqual([["a", "26061"]]);
    expect(recheckSales([{ ...sale("a", "BHC001", "202408"), postSaleRecall: { recallNumber: "26061" } }])).toEqual([]);
  });
});

describe("push subscriptions only reach real browser push services (no SSRF)", () => {
  const keys = { p256dh: "BN" + "a".repeat(80), auth: "x".repeat(22) };
  it("accepts FCM, Mozilla, Apple and Windows push endpoints over https", () => {
    for (const e of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://web.push.apple.com/abc", "https://wns2-par02p.notify.windows.com/w/?token=abc"]) {
      expect(parseSubscription({ endpoint: e, keys })).not.toBeNull();
    }
  });
  it("refuses any other host, plain http, and look-alike hosts", () => {
    for (const e of ["https://evil.example/push", "http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.example/x", "https://169.254.169.254/latest", "not a url"]) {
      expect(parseSubscription({ endpoint: e, keys })).toBeNull();
    }
    expect(parseSubscription({ endpoint: "https://fcm.googleapis.com/x" })).toBeNull();
  });
});

describe("recall-watch routes", () => {
  afterEach(() => vi.unstubAllEnvs());
  const post = (fn: (r: Request) => Promise<Response>, body: unknown) =>
    fn(new Request("http://x", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200)}` }, body: JSON.stringify(body) }));
  it("simulate needs a model and answers 503 (nothing simulated) without Atlas", async () => {
    vi.stubEnv("MONGODB_URI", "");
    expect((await post(simulate, { model: "ab" })).status).toBe(400);
    expect((await post(simulate, { model: "BHC001" })).status).toBe(503);
  });
  it("subscribe refuses without push keys, a foreign endpoint, or a bad deal token", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", ""); vi.stubEnv("VAPID_PRIVATE_KEY", "");
    expect((await post(subscribe, {})).status).toBe(503);
    vi.stubEnv("VAPID_PUBLIC_KEY", "pub"); vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
    expect((await post(subscribe, { token: "x", subscription: { endpoint: "https://evil.example/p", keys: { p256dh: "a", auth: "b" } } })).status).toBe(400);
  });
  it("the daily cron needs CRON_SECRET", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await cronWatch(new Request("http://x"))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", ["unit", "test", "value"].join("-"));
    expect((await cronWatch(new Request("http://x", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
  });
});
