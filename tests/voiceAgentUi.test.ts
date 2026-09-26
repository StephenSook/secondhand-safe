import { describe, it, expect } from "vitest";
import { createElement, createRef } from "react";
import { renderToString } from "react-dom/server";
import { VoiceAgent } from "@/ui/VoiceAgent";
import type { ShopHandle } from "@/ui/ShopAgent";
import { ShopWithVoice } from "@/ui/ShopWithVoice";

/** /shop is server-rendered: the ElevenLabs SDK must import and render on the server without touching the mic. */
describe("VoiceAgent server render", () => {
  it("renders the button and a text status, with no em dash", () => {
    const html = renderToString(createElement(VoiceAgent, { shop: createRef<ShopHandle>() }));
    expect(html).toContain("Talk to Lullabuy");
    expect(html).toContain("Not connected");
    expect(html).not.toContain(String.fromCharCode(0x2014));
  });
  it("mounts beside the typed search on /shop", () => {
    const html = renderToString(createElement(ShopWithVoice));
    expect(html).toContain("Talk to Lullabuy");
    expect(html).toContain("TELL THE AGENT WHAT YOU NEED");
  });
});
