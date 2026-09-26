import { describe, it, expect } from "vitest";
import { POST } from "@/app/api/mcp/route";

const call = async (body: unknown) => {
  const r = await POST(new Request("http://x/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: r.status, json: r.status === 202 ? null : await r.json() };
};

describe("MCP recall_check server (PLAN 3.3)", () => {
  it("initializes and negotiates the protocol version", async () => {
    const { json } = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(json.result.protocolVersion).toBe("2025-06-18");
    expect(json.result.capabilities.tools).toBeDefined();
    const odd = await call({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(odd.json.result.protocolVersion).toBe("2025-11-25");
  });
  it("a notification gets 202 and no body", async () => {
    expect((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });
  it("lists the one read-only tool", async () => {
    const { json } = await call({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(json.result.tools.map((t: { name: string }) => t.name)).toEqual(["recall_check"]);
    expect(json.result.tools[0].annotations.readOnlyHint).toBe(true);
  });
  it("the Harppa high chair in batch 202408 is recalled (CPSC 26-061)", async () => {
    const { json } = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "recall_check", arguments: { model: "BHC001", batch: "202408" } } });
    expect(json.result.structuredContent.verdict.kind).toBe("RECALL_MATCH");
    expect(json.result.content[0].text).toMatch(/26-?061/);
    expect(json.result.content[0].text).toMatch(/Do not buy/);
  });
  it("an unknown model is NO_MATCH and never called safe", async () => {
    const { json } = await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "recall_check", arguments: { model: "ZZT9Q41X" } } });
    expect(json.result.structuredContent.verdict.kind).toBe("NO_MATCH");
    expect(json.result.content[0].text).toMatch(/not a safety guarantee/);
    expect(json.result.content[0].text).not.toMatch(/\bsafe\b(?! guarantee)/i);
  });
  it("empty arguments, unknown tools, unknown methods and junk are refused cleanly", async () => {
    expect((await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "recall_check", arguments: {} } })).json.result.isError).toBe(true);
    expect((await call({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope" } })).json.error.code).toBe(-32602);
    expect((await call({ jsonrpc: "2.0", id: 8, method: "resources/list" })).json.error.code).toBe(-32601);
    expect((await call({ hello: 1 })).json.error.code).toBe(-32600);
    const bad = await POST(new Request("http://x/api/mcp", { method: "POST", body: "{not json" }));
    expect(bad.status).toBe(400);
  });
});
