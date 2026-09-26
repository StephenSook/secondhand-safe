import { createHash } from "node:crypto";
import webpush from "web-push";
import { getDb } from "@/server/db/mongo";

/**
 * Web Push for the recall watch (PLAN 6.2). A buyer subscribes a browser to one sale (proved by that sale's deal
 * token); when a recall is announced for it later, the browser gets a notification. Subscriptions live in Atlas
 * (`push_subs`). The server only ever sends to real browser push services (the endpoint allowlist below), so a
 * subscription can never make this server call an arbitrary URL.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /\.notify\.windows\.com$/, /^android\.googleapis\.com$/];

export interface PushSub { endpoint: string; keys: { p256dh: string; auth: string } }

export function parseSubscription(v: unknown): PushSub | null {
  const s = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (typeof s?.endpoint !== "string" || s.endpoint.length > 1000) return null;
  let u: URL;
  try { u = new URL(s.endpoint); } catch { return null; }
  if (u.protocol !== "https:" || !PUSH_HOSTS.some((h) => h.test(u.hostname))) return null;
  const { p256dh, auth } = s.keys ?? {};
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100) return null;
  return { endpoint: s.endpoint, keys: { p256dh, auth } };
}

export function vapid(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim(), privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim() || "https://lullabuy.tech";
  return publicKey && privateKey ? { publicKey, privateKey, subject } : null;
}

const subId = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex").slice(0, 32);

export async function saveSubscription(dealId: string, sub: PushSub): Promise<boolean> {
  const db = await getDb().catch(() => null);
  if (!db) return false;
  await db.collection<{ _id: string }>("push_subs").updateOne({ _id: subId(sub.endpoint) },
    { $set: { dealId, sub, updatedAt: new Date().toISOString() } }, { upsert: true });
  return true;
}

/** Sends one notification to every browser watching these sales; drops subscriptions the push service says are gone. */
export async function notify(dealIds: string[], payload: { title: string; body: string; url: string; tag: string }): Promise<{ sent: number; failed: number }> {
  const keys = vapid();
  const db = await getDb().catch(() => null);
  if (!keys || !db || !dealIds.length) return { sent: 0, failed: 0 };
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  const col = db.collection<{ _id: string; dealId: string; sub: PushSub }>("push_subs");
  const subs = await col.find({ dealId: { $in: dealIds.slice(0, 200) } }, { maxTimeMS: 4000 }).limit(500).toArray();
  let sent = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(s.sub, JSON.stringify({ ...payload, url: payload.url.replace("{deal}", encodeURIComponent(s.dealId)) }), { TTL: 3600, timeout: 8000 });
      sent++;
    } catch (e) {
      failed++;
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await col.deleteOne({ _id: s._id }).catch(() => {});
    }
  }));
  return { sent, failed };
}
