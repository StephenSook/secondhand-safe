"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { ConversationProvider, useConversation, useConversationClientTool } from "@elevenlabs/react";
import type { ShopHandle } from "./ShopAgent";

/**
 * Talk to Lullabuy (PLAN 5.6): a real ElevenLabs conversational agent. The browser gets a signed URL from our
 * server (the API key never leaves it), the agent searches the same pre-screened listings through our webhook, and
 * two client tools make this page follow the conversation: show_results runs the search on screen, propose_hold
 * points at one listing. The agent never places a hold or takes payment; the parent taps the hold button.
 */
type Phase = "idle" | "mic" | "starting" | "live" | "ended" | "error";

const LOOK = {
  idle: { icon: "🎙", text: "Not connected", chip: "bg-sand" },
  connecting: { icon: "◌", text: "Connecting…", chip: "bg-amber-soft" },
  listening: { icon: "●", text: "Listening", chip: "bg-green-soft" },
  speaking: { icon: "🔊", text: "Speaking", chip: "bg-aqua" },
  ended: { icon: "■", text: "Conversation ended", chip: "bg-sand" },
  error: { icon: "!", text: "Stopped", chip: "bg-red-soft" },
} as const;

export function VoiceAgent({ shop }: { shop: RefObject<ShopHandle | null> }) {
  return (
    <ConversationProvider>
      <VoicePanel shop={shop} />
    </ConversationProvider>
  );
}

function VoicePanel({ shop }: { shop: RefObject<ShopHandle | null> }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [problem, setProblem] = useState("");
  const [agentLine, setAgentLine] = useState("");
  const [userLine, setUserLine] = useState("");
  const phaseRef = useRef<Phase>("idle");
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const convo = useConversation({
    onConnect: () => setPhase("live"),
    onDisconnect: () => setPhase((p) => (p === "error" ? p : "ended")),
    onError: (message: string) => {
      setProblem(message || "The voice connection failed.");
      setPhase("error");
    },
    onMessage: ({ message, role }) => {
      if (role === "agent") setAgentLine(message);
      else setUserLine(message);
    },
  });
  const { endSession } = convo;

  useConversationClientTool("show_results", async (params: Record<string, unknown>) => {
    const q = typeof params.q === "string" ? params.q : "";
    if (!shop.current) return "The results panel is not on this page.";
    return shop.current.show(q);
  });
  useConversationClientTool("propose_hold", (params: Record<string, unknown>) => {
    const id = typeof params.listingId === "string" ? params.listingId : "";
    if (!shop.current) return "The results panel is not on this page.";
    return shop.current.propose(id);
  });

  // leaving the page ends the call (the provider also ends it when it unmounts)
  useEffect(() => () => endSession(), [endSession]);

  async function start() {
    setProblem(""); setAgentLine(""); setUserLine("");
    setPhase("mic");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("no mic"), { name: "NotSupportedError" });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop()); // permission only; the SDK opens its own stream
    } catch (e) {
      const name = (e as Error).name;
      setProblem(name === "NotAllowedError" || name === "SecurityError"
        ? "Microphone access was blocked. Allow the microphone for this site in the browser's address bar, then try again."
        : name === "NotFoundError" ? "No microphone was found on this device." : "This browser cannot use a microphone here. Type your request instead.");
      setPhase("error");
      return;
    }
    setPhase("starting");
    try {
      const r = await fetch("/api/voice-agent/session", { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as { signedUrl?: string; error?: string };
      if (!r.ok || !j.signedUrl) throw new Error(j.error ?? `HTTP ${r.status}`);
      if (phaseRef.current !== "starting") return; // the parent pressed End while we were waiting
      convo.startSession({ signedUrl: j.signedUrl, connectionType: "websocket" });
    } catch (e) {
      setProblem((e as Error).message);
      setPhase("error");
    }
  }

  function stop() {
    endSession();
    setPhase("ended");
  }

  const busy = phase === "mic" || phase === "starting" || (phase === "live" && convo.status === "connecting");
  const inCall = phase === "live" && convo.status === "connected";
  const look = inCall ? LOOK[convo.isSpeaking ? "speaking" : "listening"]
    : busy ? LOOK.connecting
    : phase === "ended" ? LOOK.ended
    : phase === "error" ? LOOK.error
    : LOOK.idle;
  const active = busy || inCall;

  return (
    <section aria-label="Talk to Lullabuy" className="rounded-[2rem] border-[3px] border-ink bg-ink text-paper p-5 sm:p-6 shadow-[6px_8px_0_var(--visa)]">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <button type="button" onClick={active ? stop : () => void start()}
          aria-label={active ? "End the conversation with Lullabuy" : "Talk to Lullabuy"}
          className={`h-14 rounded-2xl border-[3px] border-paper px-5 text-lg font-extrabold inline-flex items-center gap-2 ${active ? "bg-red text-paper" : "bg-aqua text-ink hover:bg-amber"}`}>
          <span aria-hidden>{active ? "■" : "🎙"}</span>
          {active ? "End conversation" : "Talk to Lullabuy"}
        </button>
        <p role="status" aria-live="polite" className={`inline-flex items-center gap-2 self-start sm:self-auto rounded-full border-2 border-paper px-3 py-1 text-sm font-extrabold text-ink ${look.chip}`}>
          <span aria-hidden className={inCall && !convo.isSpeaking ? "animate-pulse" : ""}>{look.icon}</span>
          {look.text}
        </p>
      </div>
      <p className="mt-3 text-sm font-semibold opacity-80">
        Say it out loud, in English or Spanish: &quot;a bassinet under 80 dollars near Midtown&quot;. The results appear below
        as it talks. It can point at a listing, but only you can tap the hold button.
      </p>
      {(agentLine || userLine) && (
        <div className="mt-3 grid gap-1 rounded-xl border-2 border-paper/40 p-3 text-sm font-semibold">
          {userLine && <p><span className="opacity-70">You: </span>{userLine}</p>}
          {agentLine && <p><span className="opacity-70">Lullabuy: </span>{agentLine}</p>}
        </div>
      )}
      {problem && <p role="alert" className="mt-3 font-bold text-red-soft">{problem}</p>}
    </section>
  );
}
