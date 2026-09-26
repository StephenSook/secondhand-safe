import { describe, it, expect, beforeEach } from "vitest";
import { parseWif, wifGeminiKey, _resetWifCache } from "@/server/ml/gcpToken";

const cfg = parseWif("wif:curtail-505118:672785135387:vercel:vercel:lullabuy-vertex@curtail-505118.iam.gserviceaccount.com")!;

describe("keyless Vertex via Vercel OIDC + Workload Identity Federation", () => {
  beforeEach(() => _resetWifCache());
  it("parses only a complete wif config", () => {
    expect(cfg.projectNumber).toBe("672785135387");
    expect(parseWif("AIzaSy-real-looking-key")).toBeNull();
    expect(parseWif("wif:a:b:c:d")).toBeNull();
  });
  it("exchanges the OIDC token at STS, then for a service-account token, and caches it", async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.includes("sts.googleapis.com")) {
        const b = JSON.parse(String(init.body));
        expect(b.subjectToken).toBe("oidc-jwt");
        expect(b.audience).toBe("//iam.googleapis.com/projects/672785135387/locations/global/workloadIdentityPools/vercel/providers/vercel");
        return Response.json({ access_token: "sts-tok" });
      }
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer sts-tok");
      return Response.json({ accessToken: "sa-tok", expireTime: new Date(Date.now() + 3600_000).toISOString() });
    }) as unknown as typeof fetch;
    expect(await wifGeminiKey(cfg, f, async () => "oidc-jwt")).toBe("vertex:curtail-505118:sa-tok");
    expect(await wifGeminiKey(cfg, f, async () => "oidc-jwt")).toBe("vertex:curtail-505118:sa-tok");
    expect(calls.length).toBe(2); // second call served from cache
  });
  it("a refusal is an error with Google's reason, never a bad key", async () => {
    const f = (async () => Response.json({ error_description: "The audience in ID Token does not match" }, { status: 400 })) as unknown as typeof fetch;
    await expect(wifGeminiKey(cfg, f, async () => "x")).rejects.toThrow(/audience/);
  });
});
