import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { signRequest, verifyRequest, keyFromSeedHex } from "@/server/tap/tap";

const seedHex = randomBytes(32).toString("hex");
const pub = keyFromSeedHex(seedHex).pubRawB64u;
const keys = (id: string) => (id === "agent-1" ? pub : undefined);
const mkSeen = () => { const seen = new Set<string>(); return async (n: string) => { const s = seen.has(n); seen.add(n); return s; }; };
const URL_ = "https://secondhand-safe-web.vercel.app/api/checkout";
const body = JSON.stringify({ listing: "Harppa high chair", amountUsd: 64 });

describe("Trusted Agent Protocol (RFC 9421, Ed25519)", () => {
  it("valid passes, then the same request replayed fails", async () => {
    const seen = mkSeen();
    const h = signRequest("POST", URL_, body, { id: "agent-1", seedHex });
    expect(await verifyRequest("POST", URL_, body, h, keys, seen)).toMatchObject({ ok: true, keyid: "agent-1" });
    expect(await verifyRequest("POST", URL_, body, h, keys, seen)).toMatchObject({ ok: false, reason: "replay" });
  });
  it("an edited amount fails the digest", async () => {
    const h = signRequest("POST", URL_, body, { id: "agent-1", seedHex });
    expect(await verifyRequest("POST", URL_, body.replace("64", "6.4"), h, keys, mkSeen())).toMatchObject({ ok: false, reason: "digest" });
  });
  it("a digest swapped to match the edited body fails the signature", async () => {
    const h = signRequest("POST", URL_, body, { id: "agent-1", seedHex });
    const edited = body.replace("64", "6.4");
    const { contentDigest } = await import("@/server/tap/tap");
    expect(await verifyRequest("POST", URL_, edited, { ...h, "content-digest": contentDigest(edited) }, keys, mkSeen()))
      .toMatchObject({ ok: false, reason: "signature" });
  });
  it("a different path or method fails the signature", async () => {
    const h = signRequest("POST", URL_, body, { id: "agent-1", seedHex });
    expect(await verifyRequest("POST", URL_.replace("checkout", "pickup"), body, h, keys, mkSeen())).toMatchObject({ ok: false, reason: "signature" });
    expect(await verifyRequest("PUT", URL_, body, h, keys, mkSeen())).toMatchObject({ ok: false, reason: "signature" });
  });
  it("created 600 s ago is expired", async () => {
    const t = Math.floor(Date.now() / 1000) - 600;
    const h = signRequest("POST", URL_, body, { id: "agent-1", seedHex }, t);
    expect(await verifyRequest("POST", URL_, body, h, keys, mkSeen())).toMatchObject({ ok: false, reason: "expired" });
  });
  it("an unknown key id is refused", async () => {
    const h = signRequest("POST", URL_, body, { id: "agent-2", seedHex });
    expect(await verifyRequest("POST", URL_, body, h, keys, mkSeen())).toMatchObject({ ok: false, reason: "unknown-key" });
  });
  it("a bad signature never records its nonce (junk cannot fill the store) and never throws", async () => {
    const seenSet = new Set<string>();
    const seen = async (n: string) => { const s = seenSet.has(n); seenSet.add(n); return s; };
    const h = signRequest("POST", URL_, body, { id: "agent-1", seedHex });
    expect(await verifyRequest("POST", URL_, body, { ...h, signature: "sig1=:AAAA:" }, keys, seen)).toMatchObject({ ok: false, reason: "signature" });
    expect(seenSet.size).toBe(0);
  });
  it("an oversized nonce is malformed", async () => {
    const h = signRequest("POST", URL_, body, { id: "agent-1", seedHex });
    const big = h["signature-input"].replace(/nonce="[^"]+"/, `nonce="${"a".repeat(500)}"`);
    expect(await verifyRequest("POST", URL_, body, { ...h, "signature-input": big }, keys, mkSeen())).toMatchObject({ ok: false, reason: "malformed" });
  });
  it("a widened window in Signature-Input is refused", async () => {
    const h = signRequest("POST", URL_, body, { id: "agent-1", seedHex });
    const widened = h["signature-input"].replace(/expires=(\d+)/, (_, e) => `expires=${Number(e) + 100000}`);
    expect(await verifyRequest("POST", URL_, body, { ...h, "signature-input": widened }, keys, mkSeen())).toMatchObject({ ok: false, reason: "expired" });
  });
});
