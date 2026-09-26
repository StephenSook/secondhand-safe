import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// the page's data sources are mocked; the page's own decisions (which Core state, whether to keep refreshing) are real
vi.mock("@/ui/Nav", () => ({ Nav: () => null }));
vi.mock("@/ui/AutoRefresh", () => ({
  AutoRefresh: (p: { everyMs?: number; times?: number }) => createElement("i", { "data-refresh": `${p.everyMs ?? 3000}x${p.times ?? 15}` }),
}));
vi.mock("@/server/solana/memo", async (orig) => ({ ...(await orig<typeof import("@/server/solana/memo")>()), readPassport: vi.fn(), passportSigner: () => "SIGNER" }));
vi.mock("@/server/solana/core", async (orig) => ({ ...(await orig<typeof import("@/server/solana/core")>()), readPassportAsset: vi.fn() }));
vi.mock("@/server/deals/store", async (orig) => ({ ...(await orig<typeof import("@/server/deals/store")>()), getDeal: vi.fn() }));
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/server/solana/mints", async (orig) => ({ ...(await orig<typeof import("@/server/solana/mints")>()), atlasMintStore: () => ({ get }) }));

import { readPassport, recordHash, passportMemo } from "@/server/solana/memo";
import { readPassportAsset, passportAttributes, attributesToRecord } from "@/server/solana/core";
import { getDeal } from "@/server/deals/store";
import PassportPage from "@/app/passport/[sig]/page";

const DEAL = "shs-0123abcd-4567";
const RECORD = JSON.stringify({ v: 1, dealId: DEAL });
const SIG = "5".repeat(88);
const ASSET = "A".repeat(43);

async function render(memoAgeS = 10) {
  vi.mocked(readPassport).mockResolvedValue({ memo: passportMemo(DEAL, recordHash(RECORD)), ok: true, signer: "SIGNER", slot: 1,
    blockTime: Math.floor(Date.now() / 1000) - memoAgeS } as never);
  const el = await PassportPage({ params: Promise.resolve({ sig: SIG }), searchParams: Promise.resolve({ r: Buffer.from(RECORD).toString("base64url") }) });
  const html = renderToString(el);
  return { html, core: html.match(/data-core="([a-z_]+)"/)?.[1] ?? null, refresh: html.match(/data-refresh="([^"]+)"/)?.[1] ?? null };
}
const deal = (passportAsset: string | null) => vi.mocked(getDeal).mockResolvedValue({ state: "ok", deal: { dealId: DEAL, passportAsset } } as never);

beforeEach(() => { vi.mocked(readPassportAsset).mockReset(); get.mockReset(); });

describe("/passport/[sig]: the Core passport while it is being minted", () => {
  it("memo verified, asset not linked yet, claim pending: shows 'being minted' and keeps a bounded 3 s refresh (90 s)", async () => {
    deal(null);
    get.mockResolvedValue({ state: "pending" });
    const r = await render();
    expect(r.html).toContain("Verified");
    expect(r.core).toBe("minting");
    expect(r.html).toContain("Core passport being minted");
    expect(r.refresh).toBe("3000x30");
  });
  it("uncertain and minted-but-unlinked claims also count as being minted", async () => {
    deal(null);
    for (const state of ["uncertain", "minted"]) {
      get.mockResolvedValue({ state });
      expect((await render()).core).toBe("minting");
    }
  });
  it("a fresh sale with no claim yet is being minted; an old one with no claim shows nothing and stops refreshing", async () => {
    deal(null);
    get.mockResolvedValue("none");
    expect(await render(10)).toMatchObject({ core: "minting", refresh: "3000x30" });
    expect(await render(600)).toMatchObject({ core: null, refresh: null });
  });
  it("not_minted is terminal: says so plainly, keeps the Memo passport verified, and stops refreshing", async () => {
    deal(null);
    get.mockResolvedValue({ state: "not_minted" });
    const r = await render();
    expect(r.core).toBe("not_minted");
    expect(r.html).toContain("No Core asset was minted for this sale");
    expect(r.html).toContain("The Memo passport above is still verified");
    expect(r.html).toContain("Verified");
    expect(r.refresh).toBeNull();
  });
  it("an unreadable claim store keeps refreshing instead of claiming there is no asset", async () => {
    deal(null);
    get.mockResolvedValue(null);
    expect(await render()).toMatchObject({ core: "unreadable", refresh: "3000x30" });
  });
  it("linked but not readable on devnet yet: keeps refreshing; readable and matching: verified, refresh stops", async () => {
    deal(ASSET);
    vi.mocked(readPassportAsset).mockResolvedValueOnce(null);
    const waiting = await render();
    expect(waiting.html).toContain("Devnet does not show this asset yet");
    expect(waiting.refresh).toBe("3000x30");
    const attrs = attributesToRecord(passportAttributes({ verdict: "NO_MATCH", recordSha256: recordHash(RECORD), indexAsOf: "2026-09-20", dealId: DEAL, status: "CAPTURED" }));
    vi.mocked(readPassportAsset).mockResolvedValueOnce({ address: ASSET, name: "n", uri: "u", owner: "SIGNER", updateAuthority: "SIGNER", attributes: attrs });
    const done = await render();
    expect(done.html).toContain("attributes match this record");
    expect(done.refresh).toBeNull();
    expect(get).not.toHaveBeenCalled(); // a linked asset needs no claim lookup
  });
});
