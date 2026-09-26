"use client";

import { useState } from "react";

/**
 * "Tell me if this item is ever recalled" (PLAN 6.2): subscribes this browser to recall-watch notifications for one
 * captured sale. The sale's deal token proves the browser holds it. Web Push: Chrome, Edge and Firefox on a computer
 * or Android; on an iPhone only after "Add to Home Screen".
 */
const b64ToBytes = (b64: string) => {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

export function WatchThisItem({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "busy" | "on" | "error">("idle");
  const [msg, setMsg] = useState("");
  async function watch() {
    setState("busy"); setMsg("");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser cannot receive notifications here. On an iPhone, add Lullabuy to the Home Screen first.");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Notifications are blocked for this site. Allow them in the address bar, then try again.");
      const key = await fetch("/api/watch/key", { cache: "no-store" }).then((r) => r.json()) as { publicKey?: string; error?: string };
      if (!key.publicKey) throw new Error(key.error ?? "Recall watch is not configured here.");
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key.publicKey) });
      const r = await fetch("/api/watch/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, subscription: sub.toJSON() }) });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setState("on");
      setMsg("Watching. If a recall is ever announced for this item, this browser gets a notification.");
    } catch (e) {
      setState("error"); setMsg((e as Error).message);
    }
  }
  return (
    <div className="mt-4 rounded-2xl border-2 border-current p-3">
      <button type="button" onClick={() => void watch()} disabled={state === "busy" || state === "on"}
        className="rounded-full border-2 border-current px-4 py-2 font-extrabold disabled:opacity-60">
        <span aria-hidden>🔔</span> {state === "on" ? "Recall watch on" : state === "busy" ? "Turning on…" : "Tell me if this item is ever recalled"}
      </button>
      {msg && <p role="status" className="mt-2 text-sm font-semibold">{msg}</p>}
    </div>
  );
}
