import { vapid } from "@/server/watch/push";

/** GET: the VAPID public key a browser needs to subscribe to recall-watch notifications. */
export function GET() {
  const k = vapid();
  if (!k) return Response.json({ error: "Recall-watch notifications are not configured on this deployment." }, { status: 503 });
  return Response.json({ publicKey: k.publicKey }, { headers: { "cache-control": "no-store" } });
}
