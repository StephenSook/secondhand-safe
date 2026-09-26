"use client";

import { useEffect, useRef, useState } from "react";

export type LiveMode = "live" | "poll";

/**
 * Calls `refresh` whenever the MongoDB change stream at `streamUrl` (GET /api/stream) reports a deal change, and
 * falls back to calling it every 3 s whenever the stream is not open: no EventSource, a 503 (Atlas unconfigured or
 * the server's stream cap), a 429, a dropped connection, or no ping for 45 s. Polling is exactly the old behavior.
 * The page always re-reads its data from the API; the stream is only the signal that something changed.
 */
export function useLiveRefresh(streamUrl: string, refresh: () => void): LiveMode {
  const [mode, setMode] = useState<LiveMode>("poll");
  const latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; }, [refresh]);

  useEffect(() => {
    let stopped = false;
    let live = false;
    let es: EventSource | null = null;
    let reopen: number | undefined;
    let watchdog: number | undefined;
    let pending: number | undefined;
    const go = (on: boolean) => { live = on; setMode(on ? "live" : "poll"); };
    const pull = () => latest.current();
    // a burst of changes (hold, then settlement) becomes one re-read
    const kick = () => { if (pending === undefined) pending = window.setTimeout(() => { pending = undefined; pull(); }, 250); };
    const drop = (retryMs: number) => {
      es?.close(); es = null;
      window.clearTimeout(watchdog);
      go(false);
      if (!stopped) { window.clearTimeout(reopen); reopen = window.setTimeout(connect, retryMs); }
    };
    const arm = () => { window.clearTimeout(watchdog); watchdog = window.setTimeout(() => drop(10_000), 45_000); };
    function connect() {
      if (stopped || typeof EventSource === "undefined") return;
      const s = new EventSource(streamUrl);
      es = s;
      s.addEventListener("ready", () => { go(true); arm(); pull(); }); // catch anything missed while connecting
      s.addEventListener("ping", arm);
      s.addEventListener("deal", () => { arm(); kick(); });
      s.addEventListener("reset", kick);
      s.onerror = () => {
        if (es !== s) return;
        // CONNECTING: the browser is reconnecting by itself (the server ends each stream after 240 s); poll meanwhile.
        // CLOSED: it gave up (503, 429, not an event stream): keep polling and try the stream again later.
        if (s.readyState === EventSource.CLOSED) drop(30_000);
        else { window.clearTimeout(watchdog); go(false); }
      };
    }
    pull();
    connect();
    const poll = window.setInterval(() => { if (!live) pull(); }, 3000);
    return () => {
      stopped = true;
      es?.close();
      window.clearInterval(poll);
      window.clearTimeout(reopen); window.clearTimeout(watchdog); window.clearTimeout(pending);
    };
  }, [streamUrl]);

  return mode;
}

export const LIVE_LABEL: Record<LiveMode, string> = { live: "live (MongoDB change stream)", poll: "refreshing every 3 s" };
