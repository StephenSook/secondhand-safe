import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { GET as session } from "@/app/api/voice-agent/session/route";
import { POST as search } from "@/app/api/voice-agent/search/route";
import { secretMatches, speakable } from "@/server/voice/agent";
import { screenAll, keywordIntent } from "@/server/shop/agent";

const SECRET = "test-tool-secret-0123456789abcdef";
const KEYS = ["ELEVENLABS_TOOL_SECRET", "ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID", "GEMINI_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

const post = (body: unknown, headers: Record<string, string> = {}) =>
  search(new Request("http://x/api/voice-agent/search", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } // GEMINI unset: keyword search, no network
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.unstubAllGlobals();
});

describe("voice agent search webhook (/api/voice-agent/search)", () => {
  it("is off (503) when no tool secret is configured", async () => {
    expect((await post({ q: "bassinet" }, { "x-lullabuy-agent": SECRET })).status).toBe(503);
  });
  it("rejects a missing or wrong secret with 401", async () => {
    process.env.ELEVENLABS_TOOL_SECRET = SECRET;
    expect((await post({ q: "bassinet" })).status).toBe(401);
    expect((await post({ q: "bassinet" }, { "x-lullabuy-agent": "wrong" })).status).toBe(401);
    expect((await post({ q: "bassinet" }, { "x-lullabuy-agent": `${SECRET}x` })).status).toBe(401);
  });
  it("returns at most 3 compact, speakable results that never say safe", async () => {
    process.env.ELEVENLABS_TOOL_SECRET = SECRET;
    for (const q of ["bassinet under 80 dollars near Midtown", "padded crib bumper", "infant sleeper", "baby car seat under $60"]) {
      const r = await post({ q }, { "x-lullabuy-agent": SECRET });
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      const text = await r.text();
      expect(text).not.toMatch(/\bsafe\b/i);
      const j = JSON.parse(text);
      expect(j.query).toBe(q);
      expect(j.top.length).toBeLessThanOrEqual(3);
      for (const l of j.top) {
        expect(Object.keys(l).sort()).toEqual(expect.arrayContaining(["id", "title", "priceUsd", "place", "verdict", "tone", "canHold"]));
        if (l.tone === "red") { expect(l.canHold).toBe(false); expect(l.verdict).toMatch(/refused/); }
        if (l.tone !== "clear") expect(typeof l.reason).toBe("string");
        expect(l.image).toBeUndefined(); // compact: no image or URL for a voice reply
        expect(l.url).toBeUndefined();
      }
    }
  });
  it("finds a real listing for the demo request", async () => {
    process.env.ELEVENLABS_TOOL_SECRET = SECRET;
    const j = await (await post({ q: "bassinet under 80 dollars near Midtown" }, { "x-lullabuy-agent": SECRET })).json();
    expect(j.found).toBeGreaterThan(0);
  });
  it("rejects an empty request", async () => {
    process.env.ELEVENLABS_TOOL_SECRET = SECRET;
    expect((await post({ q: "" }, { "x-lullabuy-agent": SECRET })).status).toBe(400);
  });
});

describe("voice agent helpers", () => {
  it("secretMatches only on the exact secret", () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(null, SECRET)).toBe(false);
    expect(secretMatches("", SECRET)).toBe(false);
    expect(secretMatches(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(secretMatches(SECRET, "")).toBe(false);
  });
  it("speakable strips the word safe even from the law's name and keeps red listings refused", () => {
    const intent = keywordIntent("crib bumper");
    const r = { engine: "keywords" as const, reply: "", intent, ...screenAll(intent) };
    const s = speakable("crib bumper", r);
    expect(JSON.stringify(s)).not.toMatch(/\bsafe\b/i);
    expect(s.top.length).toBeLessThanOrEqual(3);
    for (const l of s.top) if (l.tone === "red") expect(l.canHold).toBe(false);
  });
});

describe("voice agent session (/api/voice-agent/session)", () => {
  const get = () => session(new Request("http://x/api/voice-agent/session", { headers: { "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}` } }));

  it("is 503 without the agent id or key", async () => {
    const r = await get();
    expect(r.status).toBe(503);
    process.env.ELEVENLABS_API_KEY = "k";
    expect((await get()).status).toBe(503);
  });
  it("mints a signed URL server side and never returns the key", async () => {
    process.env.ELEVENLABS_API_KEY = "xi-test-key-value";
    process.env.ELEVENLABS_AGENT_ID = "agent_123";
    const fetchMock = vi.fn(async () => Response.json({ signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_123&conversation_signature=sig" }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const text = await r.text();
    expect(text).not.toContain("xi-test-key-value");
    expect(JSON.parse(text).signedUrl).toMatch(/^wss:\/\//);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_123");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("xi-test-key-value");
  });
  it("is 502 when ElevenLabs refuses", async () => {
    process.env.ELEVENLABS_API_KEY = "xi-test-key-value";
    process.env.ELEVENLABS_AGENT_ID = "agent_123";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const r = await get();
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain("xi-test-key-value");
  });
});

describe("scripts/elevenlabs-agent.mjs --dry-run", () => {
  it("prints valid JSON with the secret redacted and the webhook pointed at lullabuy.tech", () => {
    const secret = "dry-run-secret-must-never-print-4f9a";
    const p = spawnSync(process.execPath, ["scripts/elevenlabs-agent.mjs", "--dry-run"], {
      encoding: "utf8", env: { ...process.env, ELEVENLABS_TOOL_SECRET: secret, ELEVENLABS_API_KEY: "xi-should-not-print" },
    });
    expect(p.status).toBe(0);
    expect(p.stdout).not.toContain(secret);
    expect(p.stdout).not.toContain("xi-should-not-print");
    expect(p.stdout).not.toContain(String.fromCharCode(0x2014)); // no em dash in anything the agent will say
    const j = JSON.parse(p.stdout);
    expect(j.dryRun).toBe(true);
    const bodies = j.requests.map((r: { body: unknown }) => r.body);
    expect(bodies[0].value).toBe("[REDACTED]");
    const names = bodies.slice(1, 4).map((b: { tool_config: { name: string } }) => b.tool_config.name);
    expect(names).toEqual(["search_lullabuy", "show_results", "propose_hold"]);
    const hook = bodies[1].tool_config.api_schema;
    expect(hook.url).toBe("https://lullabuy.tech/api/voice-agent/search");
    expect(hook.request_headers["x-lullabuy-agent"]).toHaveProperty("secret_id");
    const agent = bodies[4];
    expect(agent.name).toBe("Lullabuy shopping agent");
    expect(agent.conversation_config.tts.voice_id).toBe("EXAVITQu4vr4xnSDxMaL");
    expect(agent.platform_settings.auth.allowlist.map((a: { hostname: string }) => a.hostname))
      .toEqual(["lullabuy.tech", "www.lullabuy.tech", "secondhand-safe-web.vercel.app", "localhost"]);
  });
});
