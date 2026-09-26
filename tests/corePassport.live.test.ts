import { it, expect } from "vitest";
import { existsSync } from "node:fs";
import { balanceRefusal, newAssetSigner, passportUmi, readPassportAsset, sendCreate, updatePassportStatus, explorerAddress } from "@/server/solana/core";
import { recordHash } from "@/server/solana/memo";
import { atlasMintStore, type MintClaim } from "@/server/solana/mints";
import { getDb } from "@/server/db/mongo";

if (existsSync(".env.local") && !process.env.SOLANA_SECRET_KEY_B58) process.loadEnvFile(".env.local");
// Spends about 0.005 devnet SOL per run, so it also needs an explicit opt-in: LIVE_CORE_MINT=1.
const chainOn = process.env.LIVE_CORE_MINT === "1" && !!process.env.SOLANA_SECRET_KEY_B58;

/** Reads the asset until devnet shows the expected status (a confirmed write can lag a fresh read briefly). */
async function readUntil(addr: string, status: string) {
  for (let i = 0; i < 10; i++) {
    const a = await readPassportAsset(addr);
    if (a?.attributes.status === status) return a;
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  return readPassportAsset(addr);
}

it.skipIf(!chainOn)("mints a clearly labelled test passport on devnet, reads it, flips its status, reads it again", async () => {
  const dealId = "shs-00000000-7e57";
  const sha = recordHash(JSON.stringify({ v: 1, dealId, note: "live devnet test record, not a sale", at: new Date().toISOString() }));
  const umi = passportUmi(process.env.SOLANA_SECRET_KEY_B58 as string);
  expect(await balanceRefusal(umi)).toBeNull();
  const signer = newAssetSigner(umi);
  const address = signer.publicKey.toString();
  const made = await sendCreate(umi, signer, { verdict: "LIVE_TEST", recordSha256: sha, indexAsOf: "live-test", dealId, status: "CAPTURED" }, "https://lullabuy.tech");
  console.log("[live] create:", JSON.stringify(made), explorerAddress(address));
  expect(made.kind).toBe("ok");
  const first = await readUntil(address, "CAPTURED");
  expect(first?.attributes).toEqual({ verdict: "LIVE_TEST", recordSha256: sha, indexAsOf: "live-test", dealId, status: "CAPTURED" });
  expect(first?.updateAuthority).toBe(umi.identity.publicKey.toString());
  const upd = await updatePassportStatus(address, "RECALLED_AFTER_SALE", { recall: "LIVE-TEST" });
  expect(upd.ok).toBe(true);
  const second = await readUntil(address, "RECALLED_AFTER_SALE");
  expect(second?.attributes).toEqual({ verdict: "LIVE_TEST", recordSha256: sha, indexAsOf: "live-test", dealId, status: "RECALLED_AFTER_SALE", recall: "LIVE-TEST" });
  // a repeat of the same update reads the chain first and sends nothing
  expect(await updatePassportStatus(address, "RECALLED_AFTER_SALE", { recall: "LIVE-TEST" })).toEqual({ ok: true, address, signature: null });
}, 120_000);

/** Real Atlas, throwaway database, no chain: concurrent claims for one deal, exactly one wins; the cap counter is atomic. */
it.skipIf(!process.env.MONGODB_URI)("Atlas: claims, retakes and the send lease each have exactly one winner; counts are atomic", async () => {
  process.env.MONGODB_DB = `lullabuy_test_${Date.now()}`;
  const store = atlasMintStore();
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const claim = (i: number): MintClaim => ({ _id: "shs-00000000-c1a1", address: `Addr${i}`, state: "pending", linked: false, baseUrl: "https://example.test",
    attempts: 1, attemptAt: at, nextAttemptAt: at, linkAttempts: 0,
    fields: { verdict: "LIVE_TEST", recordSha256: "0".repeat(64), indexAsOf: "x", dealId: "shs-00000000-c1a1", status: "CAPTURED" }, createdAt: at, updatedAt: at });
  try {
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => store.claim(claim(i))));
    console.log("[live] claims:", JSON.stringify(rs));
    expect(rs.filter((r) => r === "won")).toHaveLength(1);
    expect(rs.filter((r) => r === "lost")).toHaveLength(9);
    const counts = await Promise.all(Array.from({ length: 10 }, () => store.countMint("2099-01-01")));
    expect([...counts].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await store.open(25, new Date().toISOString())).toHaveLength(1);
    const winner = rs.indexOf("won");
    const retakes = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      store.retake("shs-00000000-c1a1", { state: "pending", attempts: 1, address: `Addr${winner}` }, { attempts: 2, address: `Retry${i}` })));
    console.log("[live] retakes:", JSON.stringify(retakes));
    expect(retakes.filter((r) => r === true)).toHaveLength(1);
    const now = Date.now();
    const leases = await Promise.all(Array.from({ length: 10 }, (_, i) => store.acquireLease(`h${i}`, now, 60_000)));
    console.log("[live] leases:", JSON.stringify(leases));
    expect(leases.filter((r) => r === true)).toHaveLength(1);
    expect(leases.filter((r) => r === false)).toHaveLength(9);
    const holder = `h${leases.indexOf(true)}`;
    expect(await store.acquireLease("other", now + 1_000, 60_000)).toBe(false); // held, not expired
    expect(await store.acquireLease("other", now + 61_000, 60_000)).toBe(true); // expired: taken over
    await store.releaseLease(holder); // a stale holder's release does not free the new holder's lease
    expect(await store.acquireLease("third", now + 62_000, 60_000)).toBe(false);
    await store.releaseLease("other");
    expect(await store.acquireLease("third", now + 62_000, 60_000)).toBe(true);
  } finally {
    await (await getDb())?.dropDatabase();
  }
}, 60_000);
