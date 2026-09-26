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
it.skipIf(!process.env.MONGODB_URI)("Atlas: 20 concurrent admissions against a cap of 7 admit exactly 7; one claim per deal wins; one view takes a due claim", async () => {
  process.env.MONGODB_DB = `lullabuy_test_${Date.now()}`;
  const store = atlasMintStore();
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const claim = (i: number): MintClaim => ({ _id: "shs-00000000-c1a1", address: `Addr${i}`, state: "pending", admitted: true, linked: false, baseUrl: "https://example.test",
    attemptAt: at, nextAttemptAt: at, linkAttempts: 0,
    fields: { verdict: "LIVE_TEST", recordSha256: "0".repeat(64), indexAsOf: "x", dealId: "shs-00000000-c1a1", status: "CAPTURED" }, createdAt: at, updatedAt: at });
  try {
    const admits = await Promise.all(Array.from({ length: 20 }, () => store.admit("2099-01-01", 7)));
    console.log("[live] admits:", JSON.stringify(admits));
    expect(admits.filter((r) => r === "admitted")).toHaveLength(7);
    expect(admits.filter((r) => r === "over")).toHaveLength(13);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => store.claim(claim(i))));
    console.log("[live] claims:", JSON.stringify(rs));
    expect(rs.filter((r) => r === "won")).toHaveLength(1);
    expect(rs.filter((r) => r === "lost")).toHaveLength(9);
    expect(await store.open(25, new Date().toISOString())).toHaveLength(1);
    expect(await store.get("shs-00000000-c1a1")).toMatchObject({ state: "pending", address: `Addr${rs.indexOf("won")}` });
    expect(await store.get("shs-00000000-ffff")).toBe("none");
    // the passport-view rate limit: concurrent views of a due claim, exactly one takes it
    const now = new Date().toISOString(), hold = new Date(Date.now() + 30_000).toISOString();
    const takes = await Promise.all(Array.from({ length: 10 }, () => store.takeDue("shs-00000000-c1a1", now, hold)));
    console.log("[live] takeDue:", JSON.stringify(takes.map((t) => (t ? "took" : null))));
    expect(takes.filter((t) => t !== null)).toHaveLength(1);
    expect(await store.takeDue("shs-00000000-c1a1", now, hold)).toBeNull();
  } finally {
    await (await getDb())?.dropDatabase();
  }
}, 60_000);
