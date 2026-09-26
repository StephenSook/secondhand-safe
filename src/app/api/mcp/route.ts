import { handle } from "@/server/mcp/rpc";

/**
 * MCP endpoint (Streamable HTTP, stateless, JSON responses). Try it:
 *   curl -s https://<host>/api/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recall_check","arguments":{"model":"BHC001","batch":"202408"}}}'
 */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id" };

export async function POST(request: Request) {
  const body = await request.json().catch(() => undefined);
  if (body === undefined) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: CORS });
  const out = Array.isArray(body) ? body.slice(0, 20).map(handle).filter(Boolean) : handle(body);
  if (out === null || (Array.isArray(out) && out.length === 0)) return new Response(null, { status: 202, headers: CORS });
  return Response.json(out, { headers: { ...CORS, "cache-control": "no-store" } });
}

/** No server-initiated stream: this server only answers requests. */
export function GET() {
  return new Response("This MCP server is stateless: POST JSON-RPC to this URL.", { status: 405, headers: { ...CORS, allow: "POST, OPTIONS" } });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "POST, GET, OPTIONS" } });
}
