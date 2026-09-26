import { describe, it, expect } from "vitest";
import { POST } from "@/app/api/checkout/route";

const unsigned = (ip: string) => POST(new Request("http://x/api/checkout", {
  method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: "{}", // invalid on purpose: 400 before Visa
}));

describe("unsigned checkouts are rate limited per IP, before anything reaches Visa", () => {
  it("allows 20 a minute from one address, refuses the 21st with 429, and leaves other addresses alone", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200)}`;
    for (let i = 0; i < 20; i++) expect((await unsigned(ip)).status).toBe(400);
    const r = await unsigned(ip);
    expect(r.status).toBe(429);
    expect((await r.json()).error).toMatch(/No payment was attempted/);
    expect((await unsigned("198.51.100.7")).status).toBe(400);
  });
});
