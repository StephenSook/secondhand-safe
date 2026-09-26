import { integrationStatus } from "@/server/env";
import { INDEX_SIZE } from "@/server/recalls/match";

/** Liveness plus which integrations are configured (booleans only, never a value). */
export async function GET() {
  return Response.json(
    { ok: true, at: new Date().toISOString(), recallIndex: INDEX_SIZE, integrations: integrationStatus() },
    { headers: { "cache-control": "no-store" } },
  );
}
