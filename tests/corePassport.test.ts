import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { lamports } from "@metaplex-foundation/umi";

// no network: the Core instructions and fetches are mocked; the umi client itself is real (built from a fresh key)
vi.mock("@metaplex-foundation/mpl-core", async (orig) => {
  const real = await orig<typeof import("@metaplex-foundation/mpl-core")>();
  return { ...real, create: vi.fn(), updatePlugin: vi.fn(), fetchAsset: vi.fn(), safeFetchAssetV1: vi.fn() };
});
import * as core from "@metaplex-foundation/mpl-core";
import {
  passportAttributes, mergeAttributes, updatePassportStatus, passportUmi, readPassportAsset, judgeAsset,
  MIN_BALANCE_LAMPORTS, type PassportFields,
} from "@/server/solana/core";
import { b58encode, recordHash } from "@/server/solana/memo";
import { passportMeta } from "@/server/solana/meta";
import { GET as metaRoute } from "@/app/api/passport-meta/[id]/route";
import { boardDeal, pub, type DealRecord } from "@/server/deals/store";
import { mintPassport, reconcileMints, PASSPORT_DAILY_CAP, MINT_EXPIRY_MS, type MintClaim, type MintStore } from "@/server/solana/mints";

/** a throwaway ed25519 keypair built at runtime, in the 64-byte Solana layout */
function freshKeypairB58() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
  const pubk = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  return b58encode(Buffer.concat([seed, pubk]));
}

const HASH = recordHash(JSON.stringify({ v: 1, dealId: "shs-0123abcd-4567" }));
const FIELDS: PassportFields = { verdict: "NO_MATCH", recordSha256: HASH, indexAsOf: "2026-09-20", dealId: "shs-0123abcd-4567", status: "CAPTURED" };
const sent = (err: unknown = null) => ({ sendAndConfirm: vi.fn().mockResolvedValue({ signature: new Uint8Array(64).fill(7), result: { context: { slot: 1 }, value: { err } } }) });

function umiWithBalance(lp: bigint | Error) {
  const umi = passportUmi(freshKeypairB58());
  vi.spyOn(umi.rpc, "getBalance").mockImplementation(() => (lp instanceof Error ? Promise.reject(lp) : Promise.resolve(lamports(lp))));
  return umi;
}

beforeEach(() => { vi.mocked(core.create).mockReset(); vi.mocked(core.updatePlugin).mockReset(); vi.mocked(core.fetchAsset).mockReset(); vi.mocked(core.safeFetchAssetV1).mockReset(); });

describe("Core passport attributes", () => {
  it("builds the five attributes in a fixed order", () => {
    expect(passportAttributes(FIELDS)).toEqual([
      { key: "verdict", value: "NO_MATCH" }, { key: "recordSha256", value: HASH }, { key: "indexAsOf", value: "2026-09-20" },
      { key: "dealId", value: "shs-0123abcd-4567" }, { key: "status", value: "CAPTURED" },
    ]);
  });
  it("refuses a malformed hash, deal id, status or verdict instead of writing it on chain", () => {
    expect(() => passportAttributes({ ...FIELDS, recordSha256: "abc" })).toThrow(/64/);
    expect(() => passportAttributes({ ...FIELDS, dealId: "../etc" })).toThrow(/deal id/);
    expect(() => passportAttributes({ ...FIELDS, status: "SAFE" as never })).toThrow(/status/);
    expect(() => passportAttributes({ ...FIELDS, verdict: "" })).toThrow(/verdict/);
  });
  it("an update merges: status changes, a new key is appended, every other attribute is kept, the input is untouched", () => {
    const onChain = [...passportAttributes(FIELDS), { key: "note", value: "kept" }];
    const before = JSON.stringify(onChain);
    const merged = mergeAttributes(onChain, { status: "RECALLED_AFTER_SALE", recall: "26-123" });
    expect(merged).toEqual([
      { key: "verdict", value: "NO_MATCH" }, { key: "recordSha256", value: HASH }, { key: "indexAsOf", value: "2026-09-20" },
      { key: "dealId", value: "shs-0123abcd-4567" }, { key: "status", value: "RECALLED_AFTER_SALE" }, { key: "note", value: "kept" },
      { key: "recall", value: "26-123" },
    ]);
    expect(JSON.stringify(onChain)).toBe(before);
  });
});

/** An in-memory MintStore with Atlas's semantics: the claim is a unique-_id insert, the cap counter an atomic $inc. */
function fakeStore(o: { count?: () => number | null; link?: () => boolean | null; claimDown?: boolean } = {}) {
  const docs = new Map<string, MintClaim>();
  let n = 0;
  const links: string[] = [];
  const store: MintStore = {
    claim: async (c) => {
      await Promise.resolve(); // yield, so concurrent callers interleave before the insert as they would over the network
      if (o.claimDown) return null;
      if (docs.has(c._id)) return "lost";
      docs.set(c._id, { ...c });
      return "won";
    },
    update: async (id, patch) => { const d = docs.get(id); if (!d) return false; docs.set(id, { ...d, ...patch }); return true; },
    countMint: async () => (o.count ? o.count() : ++n),
    open: async () => [...docs.values()].filter((d) => d.state === "pending" || d.state === "uncertain" || (d.state === "minted" && !d.linked)),
    link: async (id, addr) => { const r = o.link ? o.link() : true; if (r) links.push(`${id}=${addr}`); return r; },
  };
  return { store, docs, links };
}

describe("minting the asset (one claim per deal, daily cap, stored address)", () => {
  it("refuses below 0.02 SOL and sends nothing", async () => {
    const { store, docs } = fakeStore();
    const r = await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(MIN_BALANCE_LAMPORTS - 1n));
    expect(r.state).toBe("skipped");
    expect(r.reason).toMatch(/below the 0\.02 SOL floor/);
    expect(core.create).not.toHaveBeenCalled();
    expect(docs.size).toBe(0);
  });
  it("refuses when the balance cannot be read, and never throws", async () => {
    const r = await mintPassport(FIELDS, "https://example.test", fakeStore().store, umiWithBalance(new Error("rpc down")));
    expect(r.reason).toMatch(/could not read the passport wallet balance: rpc down/);
    expect(core.create).not.toHaveBeenCalled();
  });
  it("stores the claim with its address BEFORE sending, then marks it minted and links the deal", async () => {
    const { store, docs, links } = fakeStore();
    let atSend: MintClaim | undefined;
    vi.mocked(core.create).mockImplementation(() => ({ sendAndConfirm: vi.fn().mockImplementation(async () => {
      atSend = { ...docs.get(FIELDS.dealId)! };
      return { signature: new Uint8Array(64).fill(7), result: { context: { slot: 1 }, value: { err: null } } };
    }) }) as never);
    const r = await mintPassport(FIELDS, "https://example.test/", store, umiWithBalance(1_000_000_000n));
    expect(r.state).toBe("minted");
    expect(atSend).toMatchObject({ state: "pending", address: r.address });
    const args = vi.mocked(core.create).mock.calls[0][1];
    expect(args.uri).toBe("https://example.test/api/passport-meta/shs-0123abcd-4567");
    expect(args.plugins).toEqual([{ type: "Attributes", attributeList: passportAttributes(FIELDS) }]);
    expect(args.asset.publicKey.toString()).toBe(r.address);
    expect(docs.get(FIELDS.dealId)).toMatchObject({ state: "minted", linked: true, address: r.address });
    expect(links).toEqual([`${FIELDS.dealId}=${r.address}`]);
  });
  it("concurrent mint attempts for one deal: exactly one wins the claim and sends", async () => {
    const { store, docs } = fakeStore();
    vi.mocked(core.create).mockReturnValue(sent() as never);
    const umi = umiWithBalance(1_000_000_000n);
    const rs = await Promise.all(Array.from({ length: 8 }, () => mintPassport(FIELDS, "https://example.test", store, umi)));
    expect(rs.filter((r) => r.state === "minted")).toHaveLength(1);
    expect(rs.filter((r) => r.reason === "this deal already has a mint claim")).toHaveLength(7);
    expect(core.create).toHaveBeenCalledTimes(1);
    expect(docs.size).toBe(1);
  });
  it("a second mint for the same deal later never generates a second address", async () => {
    const { store, docs } = fakeStore();
    vi.mocked(core.create).mockReturnValue(sent() as never);
    const first = await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(1_000_000_000n));
    const again = await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(1_000_000_000n));
    expect(again.state).toBe("skipped");
    expect(docs.get(FIELDS.dealId)?.address).toBe(first.address);
    expect(core.create).toHaveBeenCalledTimes(1);
  });
  it("the daily cap fails closed: an unreadable count or a count over the cap sends nothing", async () => {
    vi.mocked(core.create).mockReturnValue(sent() as never);
    const unreadable = fakeStore({ count: () => null });
    const r1 = await mintPassport(FIELDS, "https://example.test", unreadable.store, umiWithBalance(1_000_000_000n));
    expect(r1).toMatchObject({ state: "refused", reason: expect.stringMatching(/fail closed/) });
    expect(unreadable.docs.get(FIELDS.dealId)?.state).toBe("refused");
    const over = fakeStore({ count: () => PASSPORT_DAILY_CAP + 1 });
    const r2 = await mintPassport(FIELDS, "https://example.test", over.store, umiWithBalance(1_000_000_000n));
    expect(r2).toMatchObject({ state: "refused", reason: expect.stringMatching(/daily passport cap/) });
    const atCap = fakeStore({ count: () => PASSPORT_DAILY_CAP });
    expect((await mintPassport(FIELDS, "https://example.test", atCap.store, umiWithBalance(1_000_000_000n))).state).toBe("minted");
    expect(core.create).toHaveBeenCalledTimes(1);
  });
  it("without a reachable claim store nothing is sent (fail closed)", async () => {
    vi.mocked(core.create).mockReturnValue(sent() as never);
    const r = await mintPassport(FIELDS, "https://example.test", fakeStore({ claimDown: true }).store, umiWithBalance(1_000_000_000n));
    expect(r.reason).toMatch(/not reachable/);
    expect(core.create).not.toHaveBeenCalled();
  });
  it("ambiguous confirmation: a send that times out is stored as uncertain with its address, never re-sent, and reconciled when it lands", async () => {
    const { store, docs, links } = fakeStore();
    const send = vi.fn().mockRejectedValue(new Error("create timed out after 40000 ms"));
    vi.mocked(core.create).mockReturnValue({ sendAndConfirm: send } as never);
    const r = await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(1_000_000_000n));
    expect(r.state).toBe("uncertain");
    expect(docs.get(FIELDS.dealId)).toMatchObject({ state: "uncertain", address: r.address, linked: false });
    expect(send).toHaveBeenCalledTimes(1);
    // the next cron: the transaction did land, at the stored address
    const read = vi.fn(async (a: string) => (a === r.address ? { address: a } : null));
    const rec = await reconcileMints({ store, read });
    expect(read).toHaveBeenCalledWith(r.address);
    expect(rec.results).toEqual([{ dealId: FIELDS.dealId, result: "found on chain, linked" }]);
    expect(docs.get(FIELDS.dealId)).toMatchObject({ state: "minted", linked: true });
    expect(links).toEqual([`${FIELDS.dealId}=${r.address}`]);
    expect(core.create).toHaveBeenCalledTimes(1);
  });
  it("an uncertain claim whose transaction never landed is closed as failed only after it can no longer land", async () => {
    const { store, docs } = fakeStore();
    vi.mocked(core.create).mockReturnValue({ sendAndConfirm: vi.fn().mockRejectedValue(new Error("timeout")) } as never);
    const t0 = Date.parse("2026-09-26T12:00:00Z");
    await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(1_000_000_000n), () => t0);
    const read = vi.fn(async () => null);
    expect((await reconcileMints({ store, read, now: () => t0 + 60_000 })).results[0].result).toBe("not on chain yet");
    expect(docs.get(FIELDS.dealId)?.state).toBe("uncertain");
    expect((await reconcileMints({ store, read, now: () => t0 + MINT_EXPIRY_MS + 1 })).results[0].result).toBe("never landed");
    expect(docs.get(FIELDS.dealId)?.state).toBe("failed");
  });
  it("Atlas association failure: the asset is minted but the deal link fails, and the next reconcile links it", async () => {
    let linkUp = false;
    const { store, docs, links } = fakeStore({ link: () => linkUp });
    vi.mocked(core.create).mockReturnValue(sent() as never);
    const r = await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(1_000_000_000n));
    expect(r.state).toBe("minted");
    expect(docs.get(FIELDS.dealId)).toMatchObject({ state: "minted", linked: false });
    const read = vi.fn();
    expect((await reconcileMints({ store, read })).results).toEqual([{ dealId: FIELDS.dealId, result: "link retry next run" }]);
    linkUp = true;
    expect((await reconcileMints({ store, read })).results).toEqual([{ dealId: FIELDS.dealId, result: "linked" }]);
    expect(docs.get(FIELDS.dealId)?.linked).toBe(true);
    expect(links).toEqual([`${FIELDS.dealId}=${r.address}`]);
    expect(read).not.toHaveBeenCalled(); // a known-minted claim needs no devnet read
    expect(core.create).toHaveBeenCalledTimes(1);
  });
  it("reconcile starts no devnet read once the deadline says stop", async () => {
    const { store } = fakeStore();
    vi.mocked(core.create).mockReturnValue({ sendAndConfirm: vi.fn().mockRejectedValue(new Error("timeout")) } as never);
    await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(1_000_000_000n));
    const read = vi.fn();
    expect((await reconcileMints({ store, read, canStartChainWork: () => false })).results[0].result).toBe("deferred");
    expect(read).not.toHaveBeenCalled();
  });
  it("a transaction that failed on chain is recorded as failed, not reconciled", async () => {
    const { store, docs } = fakeStore();
    vi.mocked(core.create).mockReturnValue(sent({ InstructionError: [0, "Custom"] }) as never);
    const r = await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(1_000_000_000n));
    expect(r.state).toBe("failed");
    expect(docs.get(FIELDS.dealId)?.state).toBe("failed");
    expect(await store.open(25)).toEqual([]);
  });
});

describe("updatePassportStatus", () => {
  const ADDR = b58encode(Buffer.alloc(32, 9));
  it("fetches the asset first and writes the merged list, keeping the other attributes", async () => {
    const umi = umiWithBalance(1_000_000_000n);
    vi.mocked(core.fetchAsset).mockResolvedValue({ publicKey: ADDR, attributes: { attributeList: [...passportAttributes(FIELDS), { key: "note", value: "kept" }] } } as never);
    vi.mocked(core.updatePlugin).mockReturnValue(sent() as never);
    const r = await updatePassportStatus(ADDR, "RECALLED_AFTER_SALE", { recall: "26-123" }, umi);
    expect(r.ok).toBe(true);
    const list = (vi.mocked(core.updatePlugin).mock.calls[0][1].plugin as { attributeList: { key: string; value: string }[] }).attributeList;
    expect(Object.fromEntries(list.map((a) => [a.key, a.value]))).toEqual({
      verdict: "NO_MATCH", recordSha256: HASH, indexAsOf: "2026-09-20", dealId: "shs-0123abcd-4567", status: "RECALLED_AFTER_SALE", note: "kept", recall: "26-123",
    });
  });
  it("reads before it writes: when an earlier ambiguous update already landed, it sends nothing", async () => {
    const umi = umiWithBalance(1_000_000_000n);
    const landed = mergeAttributes(passportAttributes(FIELDS), { status: "RECALLED_AFTER_SALE", recall: "26-123" });
    vi.mocked(core.fetchAsset).mockResolvedValue({ publicKey: ADDR, attributes: { attributeList: landed } } as never);
    const r = await updatePassportStatus(ADDR, "RECALLED_AFTER_SALE", { recall: "26-123" }, umi);
    expect(r).toEqual({ ok: true, address: ADDR, signature: null });
    expect(core.updatePlugin).not.toHaveBeenCalled();
  });
  it("refuses a malformed address or a low balance without touching the chain", async () => {
    expect((await updatePassportStatus("not-an-address", "RECALLED_AFTER_SALE", {}, umiWithBalance(1_000_000_000n))).ok).toBe(false);
    const low = await updatePassportStatus(ADDR, "RECALLED_AFTER_SALE", {}, umiWithBalance(5n));
    expect(!low.ok && low.reason).toMatch(/below the 0\.02 SOL floor/);
    expect(core.fetchAsset).not.toHaveBeenCalled();
    expect(core.updatePlugin).not.toHaveBeenCalled();
  });
  it("without a configured key it reports why instead of throwing", async () => {
    const saved = process.env.SOLANA_SECRET_KEY_B58;
    delete process.env.SOLANA_SECRET_KEY_B58;
    try {
      const r = await updatePassportStatus(ADDR, "RECALLED_AFTER_SALE");
      expect(!r.ok && r.reason).toMatch(/not configured/);
    } finally { if (saved !== undefined) process.env.SOLANA_SECRET_KEY_B58 = saved; }
  });
});

describe("reading the asset back for the passport page", () => {
  const ADDR = b58encode(Buffer.alloc(32, 5));
  it("returns the attributes and the update authority, and null when devnet has no such asset", async () => {
    const umi = umiWithBalance(0n);
    const signer = umi.identity.publicKey.toString();
    vi.mocked(core.safeFetchAssetV1).mockResolvedValueOnce({ name: "n", uri: "u", owner: signer, updateAuthority: { type: "Address", address: signer },
      attributes: { attributeList: passportAttributes(FIELDS) } } as never);
    const a = await readPassportAsset(ADDR, umi);
    expect(a?.attributes.recordSha256).toBe(HASH);
    expect(judgeAsset(a!, signer, HASH, FIELDS.dealId).verified).toBe(true);
    expect(judgeAsset(a!, "someone-else", HASH, FIELDS.dealId).verified).toBe(false);
    expect(judgeAsset(a!, signer, recordHash("{}"), FIELDS.dealId).hashOk).toBe(false);
    expect(judgeAsset(a!, signer, HASH, "shs-ffffffff-0000").dealOk).toBe(false);
    vi.mocked(core.safeFetchAssetV1).mockResolvedValueOnce(null);
    expect(await readPassportAsset(ADDR, umi)).toBeNull();
  });
  it("a recall the deal knows about but the chain does not (or a different recall) is never verified", () => {
    const view = (attrs: Record<string, string>) => ({ address: ADDR, name: "n", uri: "u", owner: "S", updateAuthority: "S", attributes: attrs });
    const base = { verdict: "NO_MATCH", recordSha256: HASH, indexAsOf: "2026-09-20", dealId: FIELDS.dealId };
    expect(judgeAsset(view({ ...base, status: "CAPTURED" }), "S", HASH, FIELDS.dealId, null).verified).toBe(true);
    const stale = judgeAsset(view({ ...base, status: "CAPTURED" }), "S", HASH, FIELDS.dealId, "26-200");
    expect(stale).toMatchObject({ recallOk: false, verified: false });
    const older = judgeAsset(view({ ...base, status: "RECALLED_AFTER_SALE", recall: "26-100" }), "S", HASH, FIELDS.dealId, "26-200");
    expect(older).toMatchObject({ recallOk: false, verified: false });
    expect(judgeAsset(view({ ...base, status: "RECALLED_AFTER_SALE", recall: "26-200" }), "S", HASH, FIELDS.dealId, "26-200").verified).toBe(true);
    expect(judgeAsset(view({ ...base, status: "RECALLED_AFTER_SALE", recall: "26-200" }), "S", HASH, FIELDS.dealId, null).verified).toBe(false);
  });
});

describe("GET /api/passport-meta/[id]", () => {
  const call = (id: string) => metaRoute(new Request(`https://example.test/api/passport-meta/${encodeURIComponent(id)}`), { params: Promise.resolve({ id }) });
  it("validates the id strictly", async () => {
    for (const bad of ["", "shs-", "shs-XYZ12345", "../../etc/passwd", "shs-0123abcd<script>", "shs-" + "a".repeat(40), "abc-0123abcd"]) {
      expect((await call(bad)).status, bad).toBe(400);
    }
  });
  it("returns the metadata schema with absolute image and link, and never calls the item safe", async () => {
    const res = await call("shs-0123abcd-4567");
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(Object.keys(j).sort()).toEqual(["description", "external_url", "image", "name", "properties"]);
    expect(j.name).toBe("Lullabuy passport shs-0123abcd-4567");
    expect(j.image).toMatch(/^https?:\/\/[^/]+\/icons\/icon-512\.png$/);
    expect(j.external_url).toMatch(/^https?:\/\/[^/]+\/deal\/shs-0123abcd-4567$/);
    expect(JSON.stringify(j)).not.toMatch(/\bsafe\b/i);
    expect(passportMeta("shs-0123abcd-4567", "https://a.test//").image).toBe("https://a.test/icons/icon-512.png");
  });
});

describe("the asset address on public deal views", () => {
  it("the board and the public deal carry the asset address but never the Visa authorization id", () => {
    const d: DealRecord = { _id: "shs-0123abcd-4567", listing: "A listing", amountUsd: 10, status: "CAPTURED", card: null, agent: null, authId: "auth-private",
      createdAt: "t", updatedAt: "t", events: [], passportAsset: "AssetAddr1111111111111111111111111" };
    expect(boardDeal(d).passportAsset).toBe("AssetAddr1111111111111111111111111");
    expect(JSON.stringify(boardDeal(d))).not.toContain("auth-private");
    expect(JSON.stringify(pub(d))).not.toContain("auth-private");
  });
});
