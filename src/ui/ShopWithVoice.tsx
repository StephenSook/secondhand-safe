"use client";

import { useRef } from "react";
import { ShopAgent, type ShopHandle } from "./ShopAgent";
import { VoiceAgent } from "./VoiceAgent";

/** /shop: the voice agent sits beside the typed search and drives the same results list (PLAN 5.6). */
export function ShopWithVoice() {
  const shop = useRef<ShopHandle>(null);
  return (
    <div className="grid gap-6">
      <VoiceAgent shop={shop} />
      <ShopAgent ref={shop} />
    </div>
  );
}
