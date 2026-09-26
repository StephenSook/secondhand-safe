import { checkLabel, INDEX_SIZE } from "@/server/recalls/match";
import { VERDICT_LABEL, CAPTURABLE } from "@/core/verdict";
import { BRAND } from "@/core/brand";

/**
 * A stateless MCP server (Streamable HTTP, JSON responses) with one tool, recall_check, so any AI shopping agent
 * can check a baby product against our CPSC + NHTSA index before it buys (PLAN 3.3). Same matcher as /api/check.
 */
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const FIELDS = ["model", "batch", "date", "upc", "text"] as const;

export const RECALL_TOOL = {
  name: "recall_check",
  title: "Check a baby product for a recall or a resale ban",
  description:
    "Checks a used baby or nursery product against U.S. CPSC recalls and NHTSA child-seat recalls, plus the product types " +
    "that are banned from sale (inclined sleepers, crib bumpers, drop-side cribs). Pass what the label says. " +
    "Never reports a product as safe: NO_MATCH only means no match in the index as of its date.",
  inputSchema: {
    type: "object",
    properties: {
      model: { type: "string", description: "Model number from the label, e.g. BHC001" },
      batch: { type: "string", description: "Batch or lot code, if printed" },
      date: { type: "string", description: "Manufacture date (YYYY-MM or YYYY-MM-DD), needed for car seats" },
      upc: { type: "string", description: "UPC barcode digits" },
      text: { type: "string", description: "Any other label or listing text" },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

type Msg = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const ok = (id: Msg["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Msg["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export function handle(m: Msg): object | null {
  if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") return fail(m?.id, -32600, "Invalid Request");
  const isNotification = !("id" in m);
  if (isNotification) return null; // notifications/initialized etc.: nothing to answer
  switch (m.method) {
    case "initialize": {
      const asked = String(m.params?.protocolVersion ?? "");
      return ok(m.id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `${BRAND.toLowerCase()}-recall-check`, title: `${BRAND} recall check`, version: "1.0.0" },
        instructions: `Call recall_check before buying any used baby product. Index: ${INDEX_SIZE.recalls} recalls.`,
      });
    }
    case "ping":
      return ok(m.id, {});
    case "tools/list":
      return ok(m.id, { tools: [RECALL_TOOL] });
    case "tools/call": {
      if (m.params?.name !== RECALL_TOOL.name) return fail(m.id, -32602, `Unknown tool: ${String(m.params?.name)}`);
      const a = (m.params?.arguments ?? {}) as Record<string, unknown>;
      const input: Record<string, string | undefined> = {};
      for (const k of FIELDS) input[k] = typeof a[k] === "string" ? (a[k] as string).slice(0, 200) : undefined;
      if (!FIELDS.some((k) => input[k]?.trim())) {
        return ok(m.id, { isError: true, content: [{ type: "text", text: "Pass at least one of: model, batch, date, upc, text." }] });
      }
      const v = checkLabel(input);
      const r = v.recall;
      const text = [
        `${VERDICT_LABEL[v.kind]} (${v.kind}). ${v.reason}`,
        r ? `${r.source} recall ${r.recallNumber}: ${r.title}. Hazard: ${r.hazard} Remedy: ${r.remedy} ${r.url}` : "",
        CAPTURABLE.has(v.kind) ? `No match in the index as of ${v.asOf}. This is not a safety guarantee.` : "Do not buy or pay for this item until a person has checked it.",
      ].filter(Boolean).join("\n");
      return ok(m.id, { content: [{ type: "text", text }], structuredContent: { verdict: v } });
    }
    default:
      return fail(m.id, -32601, `Method not found: ${m.method}`);
  }
}
