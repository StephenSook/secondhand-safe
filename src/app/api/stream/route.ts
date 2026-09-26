import { streamDeals } from "@/server/deals/stream";

/**
 * GET /api/stream (optionally ?deal=<dealId>): deal changes pushed as Server-Sent Events from a MongoDB Atlas
 * change stream. 503 when Atlas is not configured or this instance is at its stream cap; the pages then poll
 * /api/deals every 3 s. Each stream closes itself after 240 s, inside this limit, and the browser reconnects.
 */
export const maxDuration = 300;

export function GET(request: Request) {
  return streamDeals(request);
}
