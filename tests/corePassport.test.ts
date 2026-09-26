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
import { mintPassport, reconcileMints, PASSPORT_DAILY_CAP, MAX_ATTEMPTS, MAX_LINK_ATTEMPTS, MINT_COST_LAMPORTS, RECONCILE_PER_RUN, type MintClaim, type MintStore } from "@/server/solana/mints";

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

/** An in-memory MintStore with Atlas's semantics: the claim is a unique-_id insert, retake a conditional update, the cap
 *  counter an atomic $inc, and the lease a single document that only a free (expired) or same-holder request takes. */
type FakeOpts = {
  count?: () => number | null; link?: (dealId: string) => boolean | null; claimDown?: boolean;
  /** simulates a worker that dies here: the promise never settles */
  hangLease?: boolean; hangOnState?: string;
};
function fakeStore(o: FakeOpts = {}) {
  const docs = new Map<string, MintClaim>();
  let n = 0;
  const links: string[] = [];
  const linkCalls: string[] = [];
  let lease: { holder: string; exp: number } | null = null;
  const never = <T>() => new Promise<T>(() => {});
  const store: MintStore = {
    claim: async (c) => {
      await Promise.resolve(); // yield, so concurrent callers interleave before the insert as they would over the network
      if (o.claimDown) return null;
      if (docs.has(c._id)) return "lost";
      docs.set(c._id, { ...c });
      return "won";
    },
    update: async (id, patch) => {
      if (o.hangOnState && patch.state === o.hangOnState) return never();
      const d = docs.get(id); if (!d) return false; docs.set(id, { ...d, ...patch }); return true;
    },
    retake: async (id, e, patch) => {
      await Promise.resolve();
      const d = docs.get(id);
      if (!d || d.state !== e.state || d.attempts !== e.attempts || d.address !== e.address) return false;
      docs.set(id, { ...d, ...patch });
      return true;
    },
    countMint: async () => (o.count ? o.count() : ++n),
    open: async (limit, nowIso) => [...docs.values()]
      .filter((d) => d.nextAttemptAt <= nowIso && (d.state === "pending" || d.state === "uncertain" || (d.state === "minted" && !d.linked)))
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt)).slice(0, limit),
    link: async (id, addr) => {
      linkCalls.push(id);
      const r = o.link ? o.link(id) : true;
      if (r) links.push(`${id}=${addr}`);
      return r;
    },
    acquireLease: async (holder, now, ttl) => {
      await Promise.resolve();
      if (o.hangLease) return never();
      if (lease && lease.exp >= now && lease.holder !== holder) return false;
      lease = { holder, exp: now + ttl };
      return true;
    },
    releaseLease: async (holder) => { if (lease?.holder === holder) lease = null; },
  };
  return { store, docs, links, linkCalls, o };
}
const T0 = Date.parse("2026-09-26T12:00:00Z");
const at = (ms: number) => () => T0 + ms;
const MIN = 60_000;

describe("minting the asset (one claim per deal, daily cap, stored address)", () => {
  it("below the floor plus one mint's cost it sends nothing and leaves the claim for the cron", async () => {
    const { store, docs } = fakeStore();
    const r = await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(MIN_BALANCE_LAMPORTS + MINT_COST_LAMPORTS - 1n));
    expect(r.state).toBe("pending");
    expect(r.reason).toMatch(/below the 0\.02 SOL floor plus/);
    expect(core.create).not.toHaveBeenCalled();
    expect(docs.get(FIELDS.dealId)?.state).toBe("pending");
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
    expect(atSend).toMatchObject({ state: "pending", address: r.address, attempts: 1 });
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
  it("ambiguous confirmation: a send that times out is stored as uncertain with its address, and reconciled when it lands", async () => {
    const { store, docs, links } = fakeStore();
    const send = vi.fn().mockRejectedValue(new Error("create timed out after 40000 ms"));
    vi.mocked(core.create).mockReturnValue({ sendAndConfirm: send } as never);
    const r = await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(1_000_000_000n), at(0));
    expect(r.state).toBe("uncertain");
    expect(docs.get(FIELDS.dealId)).toMatchObject({ state: "uncertain", address: r.address, linked: false });
    const read = vi.fn(async (a: string) => (a === r.address ? { address: a } : null));
    const rec = await reconcileMints({ store, read, now: at(6 * MIN) });
    expect(read).toHaveBeenCalledWith(r.address);
    expect(rec.results).toEqual([{ dealId: FIELDS.dealId, result: "found on chain, linked" }]);
    expect(docs.get(FIELDS.dealId)).toMatchObject({ state: "minted", linked: true, attempts: 1 });
    expect(links).toEqual([`${FIELDS.dealId}=${r.address}`]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("crash right before sendCreate: nothing landed, so the cron starts attempt 2 with a new address and mints", async () => {
    const f = fakeStore({ hangLease: true });
    vi.mocked(core.create).mockReturnValue(sent() as never);
    const umi = umiWithBalance(1_000_000_000n);
    void mintPassport(FIELDS, "https://example.test", f.store, umi, at(0)); // the worker dies waiting, before any send
    await vi.waitFor(() => expect(f.docs.get(FIELDS.dealId)?.state).toBe("pending"));
    const first = f.docs.get(FIELDS.dealId)!.address;
    expect(core.create).not.toHaveBeenCalled();
    f.o.hangLease = false;
    const read = vi.fn(async () => null);
    // too early: the first attempt could in principle still land, so no new attempt yet
    expect((await reconcileMints({ store: f.store, read, umi, now: at(5 * MIN - 1) })).results).toEqual([]);
    const rec = await reconcileMints({ store: f.store, read, umi, now: at(6 * MIN) });
    expect(read).toHaveBeenCalledWith(first);
    expect(rec.results).toEqual([{ dealId: FIELDS.dealId, result: "attempt 2: minted" }]);
    const d = f.docs.get(FIELDS.dealId)!;
    expect(d).toMatchObject({ state: "minted", attempts: 2, linked: true });
    expect(d.address).not.toBe(first);
    expect(core.create).toHaveBeenCalledTimes(1);
  });
  it("crash right after sendCreate: the asset landed, so the cron finds it at the stored address and never re-mints", async () => {
    const f = fakeStore({ hangOnState: "minted" });
    vi.mocked(core.create).mockReturnValue(sent() as never);
    const umi = umiWithBalance(1_000_000_000n);
    void mintPassport(FIELDS, "https://example.test", f.store, umi, at(0)); // dies while recording "minted"
    await vi.waitFor(() => expect(core.create).toHaveBeenCalledTimes(1));
    const addr = f.docs.get(FIELDS.dealId)!.address;
    expect(f.docs.get(FIELDS.dealId)?.state).toBe("pending");
    f.o.hangOnState = undefined;
    const read = vi.fn(async (a: string) => (a === addr ? { address: a } : null));
    const rec = await reconcileMints({ store: f.store, read, umi, now: at(6 * MIN) });
    expect(rec.results).toEqual([{ dealId: FIELDS.dealId, result: "found on chain, linked" }]);
    expect(f.docs.get(FIELDS.dealId)).toMatchObject({ state: "minted", linked: true, attempts: 1, address: addr });
    expect(core.create).toHaveBeenCalledTimes(1);
  });
  it("two reconcilers racing on one stale claim: exactly one takes the new attempt and sends", async () => {
    const f = fakeStore({ hangLease: true });
    vi.mocked(core.create).mockReturnValue(sent() as never);
    const umi = umiWithBalance(1_000_000_000n);
    void mintPassport(FIELDS, "https://example.test", f.store, umi, at(0));
    await vi.waitFor(() => expect(f.docs.get(FIELDS.dealId)?.state).toBe("pending"));
    f.o.hangLease = false;
    const read = vi.fn(async () => null);
    const [a, b] = await Promise.all([1, 2].map(() => reconcileMints({ store: f.store, read, umi, now: at(6 * MIN) })));
    const results = [...a.results, ...b.results].map((x) => x.result).sort();
    expect(results).toEqual(["another worker took this attempt", "attempt 2: minted"]);
    expect(core.create).toHaveBeenCalledTimes(1);
    expect(f.docs.get(FIELDS.dealId)?.attempts).toBe(2);
  });
  it("at most MAX_ATTEMPTS addresses per deal, then the claim fails for good", async () => {
    const { store, docs } = fakeStore();
    vi.mocked(core.create).mockReturnValue({ sendAndConfirm: vi.fn().mockRejectedValue(new Error("timeout")) } as never);
    const umi = umiWithBalance(1_000_000_000n);
    await mintPassport(FIELDS, "https://example.test", store, umi, at(0));
    const read = vi.fn(async () => null);
    for (let k = 1; k <= MAX_ATTEMPTS; k++) await reconcileMints({ store, read, umi, now: at(k * 6 * MIN) });
    expect(docs.get(FIELDS.dealId)).toMatchObject({ state: "failed", attempts: MAX_ATTEMPTS });
    const addrs = new Set(vi.mocked(core.create).mock.calls.map((c) => c[1].asset.publicKey.toString()));
    expect(core.create).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(addrs.size).toBe(MAX_ATTEMPTS);
  });
  it("4 distinct deals against a low shared balance: the lease serializes them and the floor is never crossed", async () => {
    const f = fakeStore();
    let bal = 30_000_000n, lowest = bal;
    const created = new Set<string>();
    vi.mocked(core.create).mockImplementation((_u, args) => ({ sendAndConfirm: vi.fn().mockImplementation(async () => {
      await new Promise((ok) => setTimeout(ok, 5)); // the send takes time, as on devnet
      created.add(args.asset.publicKey.toString());
      bal -= 4_300_000n; // measured cost of one create on devnet
      if (bal < lowest) lowest = bal;
      return { signature: new Uint8Array(64).fill(7), result: { context: { slot: 1 }, value: { err: null } } };
    }) }) as never);
    const umi = passportUmi(freshKeypairB58());
    vi.spyOn(umi.rpc, "getBalance").mockImplementation(async () => lamports(bal));
    const deals = [1, 2, 3, 4].map((i) => ({ ...FIELDS, dealId: `shs-0000000${i}-4444` }));
    await Promise.all(deals.map((d) => mintPassport(d, "https://example.test", f.store, umi, at(0))));
    const read = vi.fn(async (a: string) => (created.has(a) ? { address: a } : null));
    for (let k = 1; k <= 4; k++) await reconcileMints({ store: f.store, read, umi, now: at(k * 6 * MIN) });
    expect(lowest).toBeGreaterThanOrEqual(MIN_BALANCE_LAMPORTS);
    expect(created.size).toBe(1); // 30.0 -> 25.7 mSOL; a second mint would need 26 mSOL
    expect([...f.docs.values()].filter((d) => d.state === "failed")).toHaveLength(3);
  });
  it("Atlas association failure: the asset is minted but the deal link fails, and a later reconcile links it", async () => {
    let linkUp = false;
    const { store, docs, links } = fakeStore({ link: () => linkUp });
    vi.mocked(core.create).mockReturnValue(sent() as never);
    const r = await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(1_000_000_000n), at(0));
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
  it("25 permanently failing deal links cannot starve a newer claim, each run is bounded, and they end as link_failed", async () => {
    const NEW = "shs-99999999-0001";
    const f = fakeStore({ link: (id) => id === NEW });
    for (let i = 0; i < 25; i++) {
      const id = `shs-11111111-${String(i).padStart(4, "0")}`;
      f.docs.set(id, { _id: id, address: `Addr${i}`, state: "minted", linked: false, fields: { ...FIELDS, dealId: id }, baseUrl: "https://example.test",
        attempts: 1, attemptAt: new Date(T0 - 3_600_000).toISOString(), nextAttemptAt: new Date(T0 - 3_600_000 + i).toISOString(), linkAttempts: 0,
        createdAt: new Date(T0 - 3_600_000).toISOString(), updatedAt: new Date(T0).toISOString() });
    }
    f.docs.set(NEW, { _id: NEW, address: "AddrNew", state: "pending", linked: false, fields: { ...FIELDS, dealId: NEW }, baseUrl: "https://example.test",
      attempts: 1, attemptAt: new Date(T0 - 10 * MIN).toISOString(), nextAttemptAt: new Date(T0 - MIN).toISOString(), linkAttempts: 0,
      createdAt: new Date(T0 - 10 * MIN).toISOString(), updatedAt: new Date(T0).toISOString() });
    const read = vi.fn(async (a: string) => (a === "AddrNew" ? { address: a } : null));
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
    // later runs (backoff respected) retire every failing link after MAX_LINK_ATTEMPTS
    for (let day = 1; day <= 30; day++) await reconcileMints({ store: f.store, read, now: at(day * 24 * 60 * MIN) });
    const failing = [...f.docs.values()].filter((d) => d._id !== NEW);
    expect(failing.every((d) => d.state === "link_failed" && d.linkAttempts === MAX_LINK_ATTEMPTS)).toBe(true);
    expect(f.linkCalls.filter((id) => id !== NEW)).toHaveLength(25 * MAX_LINK_ATTEMPTS);
  });
  it("the time gate stops every branch: no devnet read and no deal link once it says stop", async () => {
    const { store, linkCalls } = fakeStore({ link: () => false });
    vi.mocked(core.create).mockReturnValue(sent() as never);
    await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(1_000_000_000n), at(0));
    const before = linkCalls.length;
    const read = vi.fn();
    const r = await reconcileMints({ store, read, now: at(6 * MIN), canStartChainWork: () => false });
    expect(r.results).toEqual([{ dealId: FIELDS.dealId, result: "deferred" }]);
    expect(read).not.toHaveBeenCalled();
    expect(linkCalls.length).toBe(before);
  });
  it("a transaction that failed on chain is recorded as failed, not reconciled", async () => {
    const { store, docs } = fakeStore();
    vi.mocked(core.create).mockReturnValue(sent({ InstructionError: [0, "Custom"] }) as never);
    const r = await mintPassport(FIELDS, "https://example.test", store, umiWithBalance(1_000_000_000n), at(0));
    expect(r.state).toBe("failed");
    expect(docs.get(FIELDS.dealId)?.state).toBe("failed");
    expect(await store.open(25, new Date(T0 + 24 * 60 * MIN).toISOString())).toEqual([]);
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
