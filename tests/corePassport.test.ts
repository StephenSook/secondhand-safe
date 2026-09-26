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
  passportAttributes, mergeAttributes, createPassportAsset, updatePassportStatus, passportUmi, readPassportAsset, judgeAsset,
  MIN_BALANCE_LAMPORTS, type PassportFields,
} from "@/server/solana/core";
import { b58encode, recordHash } from "@/server/solana/memo";
import { passportMeta } from "@/server/solana/meta";
import { GET as metaRoute } from "@/app/api/passport-meta/[id]/route";
import { boardDeal, pub, type DealRecord } from "@/server/deals/store";

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

describe("minting the asset", () => {
  it("refuses below 0.02 SOL and sends nothing", async () => {
    const r = await createPassportAsset(FIELDS, "https://example.test", umiWithBalance(MIN_BALANCE_LAMPORTS - 1n));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/below the 0\.02 SOL floor/);
    expect(core.create).not.toHaveBeenCalled();
  });
  it("refuses when the balance cannot be read, and never throws", async () => {
    const r = await createPassportAsset(FIELDS, "https://example.test", umiWithBalance(new Error("rpc down")));
    expect(!r.ok && r.reason).toMatch(/could not read the passport wallet balance: rpc down/);
    expect(core.create).not.toHaveBeenCalled();
  });
  it("creates one asset with the Attributes plugin and a metadata uri on our site", async () => {
    vi.mocked(core.create).mockReturnValue(sent() as never);
    const r = await createPassportAsset(FIELDS, "https://example.test/", umiWithBalance(1_000_000_000n));
    expect(r.ok).toBe(true);
    const args = vi.mocked(core.create).mock.calls[0][1];
    expect(args.uri).toBe("https://example.test/api/passport-meta/shs-0123abcd-4567");
    expect(args.plugins).toEqual([{ type: "Attributes", attributeList: passportAttributes(FIELDS) }]);
    expect(r.ok && r.address).toBe(args.asset.publicKey.toString());
  });
  it("a send that throws is reported as not written and is never retried (it may have landed)", async () => {
    const send = vi.fn().mockRejectedValue(new Error("block height exceeded"));
    vi.mocked(core.create).mockReturnValue({ sendAndConfirm: send } as never);
    const r = await createPassportAsset(FIELDS, "https://example.test", umiWithBalance(1_000_000_000n));
    expect(!r.ok && r.reason).toMatch(/^not written: block height exceeded/);
    expect(!r.ok && r.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(core.create).toHaveBeenCalledTimes(1);
  });
  it("a transaction that failed on chain is not a passport", async () => {
    vi.mocked(core.create).mockReturnValue(sent({ InstructionError: [0, "Custom"] }) as never);
    const r = await createPassportAsset(FIELDS, "https://example.test", umiWithBalance(1_000_000_000n));
    expect(!r.ok && r.reason).toMatch(/failed on chain/);
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
