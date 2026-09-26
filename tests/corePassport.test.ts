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
import { mintPassport, reconcileMints, dailyCap, MAX_LINK_ATTEMPTS, MINT_COST_LAMPORTS, RECONCILE_PER_RUN, type MintClaim, type MintStore } from "@/server/solana/mints";

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

/** An in-memory MintStore with Atlas's semantics: the claim is a unique-_id insert and admission a conditional $inc. */
type FakeOpts = {
  admit?: () => Promise<"admitted" | "over" | null> | "admitted" | "over" | null; link?: (dealId: string) => boolean | null; claimDown?: boolean;
  /** simulates a worker that dies here: the promise never settles */
  hangOnState?: string;
};
function fakeStore(o: FakeOpts = {}) {
  const docs = new Map<string, MintClaim>();
  const counts = new Map<string, number>();
  const links: string[] = [];
  const linkCalls: string[] = [];
  const never = <T,>() => new Promise<T>(() => {});
  const store: MintStore = {
    admit: async (day, cap) => {
      await Promise.resolve(); // yield, so concurrent callers interleave as they would over the network
      if (o.admit) return o.admit();
      const n = counts.get(day) ?? 0;
      if (n >= cap) return "over";
      counts.set(day, n + 1);
      return "admitted";
    },
    claim: async (c) => {
      await Promise.resolve();
      if (o.claimDown) return null;
      if (docs.has(c._id)) return "lost";
      docs.set(c._id, { ...c });
      return "won";
    },
    update: async (id, patch) => {
      if (o.hangOnState && patch.state === o.hangOnState) return never();
      const d = docs.get(id); if (!d) return false; docs.set(id, { ...d, ...patch }); return true;
    },
    get: async (id) => docs.get(id) ?? "none",
    open: async (limit, nowIso) => [...docs.values()]
      .filter((d) => d.admitted && d.nextAttemptAt <= nowIso && (d.state === "pending" || d.state === "uncertain" || (d.state === "minted" && !d.linked)))
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt)).slice(0, limit),
    link: async (id, addr) => {
      linkCalls.push(id);
      const r = o.link ? o.link(id) : true;
      if (r) links.push(`${id}=${addr}`);
      return r;
    },
  };
  return { store, docs, counts, links, linkCalls, o };
}
const T0 = Date.parse("2026-09-26T12:00:00Z");
const at = (ms: number) => () => T0 + ms;
const MIN = 60_000;
const RICH = 1_000_000_000n;
const claimDoc = (id: string, p: Partial<MintClaim>): MintClaim => ({ _id: id, address: `Addr-${id}`, state: "pending", admitted: true, linked: false,
  fields: { ...FIELDS, dealId: id }, baseUrl: "https://example.test", attemptAt: new Date(T0 - 10 * MIN).toISOString(),
  nextAttemptAt: new Date(T0 - MIN).toISOString(), linkAttempts: 0, createdAt: new Date(T0 - 10 * MIN).toISOString(), updatedAt: new Date(T0).toISOString(), ...p });

describe("minting the asset (cap admission, one claim per deal, one address, one send)", () => {
  it("stores the admitted claim with its address BEFORE the single send, then marks it minted and links the deal", async () => {
    const { store, docs, links } = fakeStore();
    let atSend: MintClaim | undefined;
    vi.mocked(core.create).mockImplementation(() => ({ sendAndConfirm: vi.fn().mockImplementation(async () => {
      atSend = { ...docs.get(FIELDS.dealId)! };
      return { signature: new Uint8Array(64).fill(7), result: { context: { slot: 1 }, value: { err: null } } };
    }) }) as never);
    const r = await mintPassport(FIELDS, "https://example.test/", store, umiWithBalance(RICH));
    expect(r.state).toBe("minted");
    expect(atSend).toMatchObject({ state: "pending", admitted: true, address: r.address });
    const args = vi.mocked(core.create).mock.calls[0][1];
    expect(args.uri).toBe("https://example.test/api/passport-meta/shs-0123abcd-4567");
    expect(args.plugins).toEqual([{ type: "Attributes", attributeList: passportAttributes(FIELDS) }]);
    expect(args.asset.publicKey.toString()).toBe(r.address);
    expect(docs.get(FIELDS.dealId)).toMatchObject({ state: "minted", linked: true, address: r.address });
    expect(links).toEqual([`${FIELDS.dealId}=${r.address}`]);
  });
  it("crash before cap admission: no claim exists, so nothing mints, ever", async () => {
    const f = fakeStore({ admit: () => new Promise<never>(() => {}) });
    vi.mocked(core.create).mockReturnValue(sent() as never);
    void mintPassport(FIELDS, "https://example.test", f.store, umiWithBalance(RICH), at(0)); // dies inside admission
    await new Promise((ok) => setTimeout(ok, 10));
    for (const k of [6, 60, 24 * 60]) await reconcileMints({ store: f.store, read: vi.fn(async () => null), now: at(k * MIN) });
    expect(f.docs.size).toBe(0);
    expect(core.create).not.toHaveBeenCalled();
  });
  it("over the cap, or with an unreadable counter, no claim is written and nothing is sent", async () => {
    vi.mocked(core.create).mockReturnValue(sent() as never);
    const full = fakeStore();
    const deals = [1, 2, 3].map((i) => ({ ...FIELDS, dealId: `shs-0000000${i}-4444` }));
    const rs = await Promise.all(deals.map((d) => mintPassport(d, "https://example.test", full.store, umiWithBalance(RICH), at(0), 2)));
    expect(rs.map((r) => r.state).sort()).toEqual(["minted", "minted", "refused"]);
    expect(rs.find((r) => r.state === "refused")?.reason).toMatch(/daily passport cap of 2 reached/);
    expect(full.docs.size).toBe(2);
    const down = fakeStore({ admit: () => null });
    const r = await mintPassport(FIELDS, "https://example.test", down.store, umiWithBalance(RICH), at(0));
    expect(r).toMatchObject({ state: "refused", reason: expect.stringMatching(/fail closed/) });
    expect(down.docs.size).toBe(0);
    expect(core.create).toHaveBeenCalledTimes(2);
  });
  it("PASSPORT_DAILY_CAP=0 blocks the mint and the reconcile", async () => {
    expect(dailyCap("0")).toBe(0);
    expect(dailyCap("")).toBe(50);
    expect(dailyCap("abc")).toBe(50);
    const f = fakeStore();
    expect((await mintPassport(FIELDS, "https://example.test", f.store, umiWithBalance(RICH), at(0), 0)).state).toBe("skipped");
    f.docs.set(FIELDS.dealId, claimDoc(FIELDS.dealId, { state: "uncertain" }));
    const read = vi.fn(async (a: string) => ({ address: a }));
    const r = await reconcileMints({ store: f.store, read, now: at(6 * MIN), cap: 0 });
    expect(r).toMatchObject({ checked: 0, off: true });
    expect(read).not.toHaveBeenCalled();
    expect(f.linkCalls).toEqual([]);
    expect(f.docs.get(FIELDS.dealId)?.state).toBe("uncertain");
    expect(core.create).not.toHaveBeenCalled();
  });
  it("a claim that was never admitted is never reconciled", async () => {
    const f = fakeStore();
    const unadmitted = { ...claimDoc(FIELDS.dealId, {}), admitted: false } as unknown as MintClaim;
    f.docs.set(FIELDS.dealId, unadmitted);
    const read = vi.fn(async (a: string) => ({ address: a }));
    // even a store that returns it anyway: reconcile checks the flag itself
    const leaky: MintStore = { ...f.store, open: async () => [unadmitted] };
    expect((await reconcileMints({ store: leaky, read, now: at(6 * MIN) })).results).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(f.linkCalls).toEqual([]);
  });
  it("concurrent mints for one deal: exactly one wins the claim and sends", async () => {
    const { store, docs } = fakeStore();
    vi.mocked(core.create).mockReturnValue(sent() as never);
    const umi = umiWithBalance(RICH);
    const rs = await Promise.all(Array.from({ length: 8 }, () => mintPassport(FIELDS, "https://example.test", store, umi)));
    expect(rs.filter((r) => r.state === "minted")).toHaveLength(1);
    expect(rs.filter((r) => r.reason === "this deal already has a mint claim")).toHaveLength(7);
    expect(core.create).toHaveBeenCalledTimes(1);
    expect(docs.size).toBe(1);
  });
  it("without a reachable claim store nothing is sent (fail closed)", async () => {
    vi.mocked(core.create).mockReturnValue(sent() as never);
    const r = await mintPassport(FIELDS, "https://example.test", fakeStore({ claimDown: true }).store, umiWithBalance(RICH));
    expect(r.reason).toMatch(/not reachable/);
    expect(core.create).not.toHaveBeenCalled();
  });
  it("below the floor plus one mint's cost, or with an unreadable balance, it sends nothing and ends not_minted", async () => {
    const low = fakeStore();
    const r = await mintPassport(FIELDS, "https://example.test", low.store, umiWithBalance(MIN_BALANCE_LAMPORTS + MINT_COST_LAMPORTS - 1n));
    expect(r).toMatchObject({ state: "not_minted", reason: expect.stringMatching(/below the 0\.02 SOL floor plus/) });
    expect(low.docs.get(FIELDS.dealId)?.state).toBe("not_minted");
    const down = await mintPassport(FIELDS, "https://example.test", fakeStore().store, umiWithBalance(new Error("rpc down")));
    expect(down.reason).toMatch(/could not read the passport wallet balance: rpc down/);
    expect(core.create).not.toHaveBeenCalled();
  });
  it("uncertain, then the asset lands: the cron finds it at the stored address and links it", async () => {
    const { store, docs, links } = fakeStore();
    const send = vi.fn().mockRejectedValue(new Error("create timed out after 40000 ms"));
    vi.mocked(core.create).mockReturnValue({ sendAndConfirm: send } as never);
    const r = await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(RICH), at(0));
    expect(r.state).toBe("uncertain");
    expect(docs.get(FIELDS.dealId)).toMatchObject({ state: "uncertain", address: r.address, linked: false });
    const read = vi.fn(async (a: string) => (a === r.address ? { address: a } : null));
    const rec = await reconcileMints({ store, read, now: at(6 * MIN) });
    expect(read).toHaveBeenCalledWith(r.address);
    expect(rec.results).toEqual([{ dealId: FIELDS.dealId, result: "found on chain, linked" }]);
    expect(docs.get(FIELDS.dealId)).toMatchObject({ state: "minted", linked: true });
    expect(links).toEqual([`${FIELDS.dealId}=${r.address}`]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("uncertain, then it never lands: waits out the window, then not_minted, and never sends a second time", async () => {
    const { store, docs } = fakeStore();
    const send = vi.fn().mockRejectedValue(new Error("timeout"));
    vi.mocked(core.create).mockReturnValue({ sendAndConfirm: send } as never);
    const r = await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(RICH), at(0));
    const read = vi.fn(async () => null);
    // too early to be sure: the claim is not due yet, so nothing is read or settled
    expect((await reconcileMints({ store, read, now: at(5 * MIN - 1) })).results).toEqual([]);
    expect((await reconcileMints({ store, read, now: at(5 * MIN) })).results).toEqual([{ dealId: FIELDS.dealId, result: "not minted" }]);
    expect(docs.get(FIELDS.dealId)).toMatchObject({ state: "not_minted", address: r.address });
    for (const k of [10, 60, 24 * 60]) await reconcileMints({ store, read, now: at(k * MIN) });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(r.address);
    expect(send).toHaveBeenCalledTimes(1);
    expect(core.create).toHaveBeenCalledTimes(1);
    // due but still inside its window (its send was prepared a minute ago): left pending, not settled early
    docs.set("shs-33333333-0001", claimDoc("shs-33333333-0001", { attemptAt: new Date(T0 - MIN).toISOString() }));
    expect((await reconcileMints({ store, read, now: at(0) })).results).toEqual([{ dealId: "shs-33333333-0001", result: "not on chain yet" }]);
    expect(docs.get("shs-33333333-0001")).toMatchObject({ state: "pending", nextAttemptAt: new Date(T0 + 4 * MIN).toISOString() });
  });
  it("crash after the claim but before the send: the address never lands and the claim ends not_minted", async () => {
    const f = fakeStore();
    const umi = passportUmi(freshKeypairB58());
    vi.spyOn(umi.rpc, "getBalance").mockImplementation(() => new Promise(() => {})); // the worker dies here
    void mintPassport(FIELDS, "https://example.test", f.store, umi, at(0));
    await vi.waitFor(() => expect(f.docs.get(FIELDS.dealId)?.state).toBe("pending"));
    const read = vi.fn(async () => null);
    expect((await reconcileMints({ store: f.store, read, now: at(6 * MIN) })).results).toEqual([{ dealId: FIELDS.dealId, result: "not minted" }]);
    expect(core.create).not.toHaveBeenCalled();
  });
  it("crash right after the send: the asset landed, so the cron finds it at the stored address and never re-mints", async () => {
    const f = fakeStore({ hangOnState: "minted" });
    vi.mocked(core.create).mockReturnValue(sent() as never);
    void mintPassport(FIELDS, "https://example.test", f.store, umiWithBalance(RICH), at(0)); // dies while recording "minted"
    await vi.waitFor(() => expect(core.create).toHaveBeenCalledTimes(1));
    const addr = f.docs.get(FIELDS.dealId)!.address;
    expect(f.docs.get(FIELDS.dealId)?.state).toBe("pending");
    f.o.hangOnState = undefined;
    const read = vi.fn(async (a: string) => (a === addr ? { address: a } : null));
    const rec = await reconcileMints({ store: f.store, read, now: at(6 * MIN) });
    expect(rec.results).toEqual([{ dealId: FIELDS.dealId, result: "found on chain, linked" }]);
    expect(f.docs.get(FIELDS.dealId)).toMatchObject({ state: "minted", linked: true, address: addr });
    expect(core.create).toHaveBeenCalledTimes(1);
  });
  it("a transaction that failed on chain ends not_minted and is not reconciled", async () => {
    const { store, docs } = fakeStore();
    vi.mocked(core.create).mockReturnValue(sent({ InstructionError: [0, "Custom"] }) as never);
    const r = await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(RICH), at(0));
    expect(r.state).toBe("not_minted");
    expect(docs.get(FIELDS.dealId)?.state).toBe("not_minted");
    expect(await store.open(25, new Date(T0 + 24 * 60 * MIN).toISOString())).toEqual([]);
  });
  it("Atlas association failure: the asset is minted but the deal link fails, and a later reconcile links it", async () => {
    let linkUp = false;
    const { store, docs, links } = fakeStore({ link: () => linkUp });
    vi.mocked(core.create).mockReturnValue(sent() as never);
    const r = await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(RICH), at(0));
    expect(r.state).toBe("minted");
    expect(docs.get(FIELDS.dealId)).toMatchObject({ state: "minted", linked: false });
    const read = vi.fn();
    expect((await reconcileMints({ store, read, now: at(6 * MIN) })).results).toEqual([{ dealId: FIELDS.dealId, result: "link retry later" }]);
    linkUp = true;
    expect((await reconcileMints({ store, read, now: at(6 * MIN + 1) })).results).toEqual([]); // backing off
    expect((await reconcileMints({ store, read, now: at(20 * MIN) })).results).toEqual([{ dealId: FIELDS.dealId, result: "linked" }]);
    expect(docs.get(FIELDS.dealId)?.linked).toBe(true);
    expect(links).toEqual([`${FIELDS.dealId}=${r.address}`]);
    expect(read).not.toHaveBeenCalled(); // a known-minted claim needs no devnet read
    expect(core.create).toHaveBeenCalledTimes(1);
  });
  it("bounded reconcile: 25 failing deal links cannot starve a newer claim, each run is capped, and they end as link_failed", async () => {
    const NEW = "shs-99999999-0001";
    const f = fakeStore({ link: (id) => id === NEW });
    for (let i = 0; i < 25; i++) {
      const id = `shs-11111111-${String(i).padStart(4, "0")}`;
      f.docs.set(id, claimDoc(id, { state: "minted", nextAttemptAt: new Date(T0 - 3_600_000 + i).toISOString() }));
    }
    f.docs.set(NEW, claimDoc(NEW, {}));
    const read = vi.fn(async (a: string) => (a === `Addr-${NEW}` ? { address: a } : null));
    let runs = 0;
    while (f.docs.get(NEW)?.linked !== true && runs < 10) {
      const before = f.linkCalls.length;
      const r = await reconcileMints({ store: f.store, read, now: at(0) });
      expect(f.linkCalls.length - before).toBeLessThanOrEqual(RECONCILE_PER_RUN);
      expect(r.results.filter((x) => x.result !== "deferred").length).toBeLessThanOrEqual(RECONCILE_PER_RUN);
      runs++;
    }
    expect(f.docs.get(NEW)).toMatchObject({ state: "minted", linked: true });
    expect(runs).toBeLessThanOrEqual(6); // 25 failures are pushed back five at a time, then the newer claim is due first
    for (let day = 1; day <= 30; day++) await reconcileMints({ store: f.store, read, now: at(day * 24 * 60 * MIN) });
    const failing = [...f.docs.values()].filter((d) => d._id !== NEW);
    expect(failing.every((d) => d.state === "link_failed" && d.linkAttempts === MAX_LINK_ATTEMPTS)).toBe(true);
    expect(f.linkCalls.filter((id) => id !== NEW)).toHaveLength(25 * MAX_LINK_ATTEMPTS);
  });
  it("the time gate stops every branch: no devnet read and no deal link once it says stop", async () => {
    const { store, docs, linkCalls } = fakeStore();
    docs.set("shs-22222222-0001", claimDoc("shs-22222222-0001", { state: "minted" }));
    docs.set("shs-22222222-0002", claimDoc("shs-22222222-0002", { state: "uncertain" }));
    const read = vi.fn();
    const r = await reconcileMints({ store, read, now: at(6 * MIN), canStartChainWork: () => false });
    expect(r.results.map((x) => x.result)).toEqual(["deferred", "deferred"]);
    expect(read).not.toHaveBeenCalled();
    expect(linkCalls).toEqual([]);
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
