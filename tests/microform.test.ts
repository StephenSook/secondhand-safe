import { describe, it, expect } from "vitest";
import { allowedOrigin, captureContext, isTransientToken } from "@/server/visa/microform";

const creds = { merchantId: "m", keyId: "k", secret: Buffer.from("s").toString("base64"), host: "apitest.cybersource.com" };

describe("Microform capture context (PLAN 3.9)", () => {
  it("issues only to our own origins", () => {
    expect(allowedOrigin("https://secondhand-safe-web.vercel.app")).toBe("https://secondhand-safe-web.vercel.app");
    expect(allowedOrigin("https://lullabuy.tech/")).toBe("https://lullabuy.tech");
    expect(allowedOrigin("http://localhost:3107")).toBe("http://localhost:3107");
    expect(allowedOrigin("https://evil.example")).toBeNull();
    expect(allowedOrigin("http://secondhand-safe-web.vercel.app")).toBeNull();
    expect(allowedOrigin("https://secondhand-safe-web.vercel.app.evil.example")).toBeNull();
    expect(allowedOrigin(null)).toBeNull();
  });
  it("signs a POST to /microform/v2/sessions naming the origin, and returns the JWT", async () => {
    let seen: { url: string; body: string; sig: string } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, body: String(init.body), sig: (init.headers as Record<string, string>).signature };
      return new Response("aaa.bbb.ccc", { status: 201 });
    }) as unknown as typeof fetch;
    expect(await captureContext(creds, "http://localhost:3107", f)).toEqual({ ok: true, jwt: "aaa.bbb.ccc" });
    expect(seen!.url).toBe("https://apitest.cybersource.com/microform/v2/sessions");
    expect(JSON.parse(seen!.body).targetOrigins).toEqual(["http://localhost:3107"]);
    expect(seen!.sig).toMatch(/headers="host date request-target digest v-c-merchant-id"/);
  });
  it("a Visa error or a network failure is a refusal, never a JWT", async () => {
    const err = (async () => new Response(JSON.stringify({ reason: "INVALID_DATA" }), { status: 400 })) as unknown as typeof fetch;
    expect(await captureContext(creds, "http://localhost:3107", err)).toEqual({ ok: false, httpStatus: 400, reason: "INVALID_DATA" });
    const html = (async () => new Response("<html>oops</html>", { status: 201 })) as unknown as typeof fetch;
    expect((await captureContext(creds, "http://localhost:3107", html)).ok).toBe(false);
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await captureContext(creds, "http://localhost:3107", down)).toMatchObject({ ok: false, httpStatus: 0 });
  });
  it("only a compact JWT of bounded size passes as a transient token", () => {
    expect(isTransientToken("eyJ.eyJ.sig")).toBe(true);
    expect(isTransientToken("4111111111111111")).toBe(false);
    expect(isTransientToken({})).toBe(false);
    expect(isTransientToken("a.b.c" + "x".repeat(9000))).toBe(false);
  });
});
