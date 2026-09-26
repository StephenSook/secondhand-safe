import { it, expect } from "vitest";
import { existsSync } from "node:fs";
import { createPassportAsset, readPassportAsset, updatePassportStatus, explorerAddress, passportUmi } from "@/server/solana/core";
import { recordHash } from "@/server/solana/memo";

// Spends about 0.005 devnet SOL per run, so it also needs an explicit opt-in: LIVE_CORE_MINT=1.
if (existsSync(".env.local") && !process.env.SOLANA_SECRET_KEY_B58) process.loadEnvFile(".env.local");
const on = process.env.LIVE_CORE_MINT === "1" && !!process.env.SOLANA_SECRET_KEY_B58;

/** Reads the asset until devnet shows the expected status (a confirmed write can lag a fresh read briefly). */
async function readUntil(addr: string, status: string) {
  for (let i = 0; i < 10; i++) {
    const a = await readPassportAsset(addr);
    if (a?.attributes.status === status) return a;
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  return readPassportAsset(addr);
}

it.skipIf(!on)("mints a clearly labelled test passport on devnet, reads it, flips its status, reads it again", async () => {
  const dealId = "shs-00000000-7e57";
  const sha = recordHash(JSON.stringify({ v: 1, dealId, note: "live devnet test record, not a sale", at: new Date().toISOString() }));
  const signer = passportUmi(process.env.SOLANA_SECRET_KEY_B58 as string).identity.publicKey.toString();
  const made = await createPassportAsset({ verdict: "LIVE_TEST", recordSha256: sha, indexAsOf: "live-test", dealId, status: "CAPTURED" }, "https://lullabuy.tech");
  console.log("[live] create:", JSON.stringify(made));
  expect(made.ok).toBe(true);
  if (!made.ok) return;
  console.log("[live] explorer:", explorerAddress(made.address));
  const first = await readUntil(made.address, "CAPTURED");
  console.log("[live] read 1:", JSON.stringify(first));
  expect(first?.attributes).toEqual({ verdict: "LIVE_TEST", recordSha256: sha, indexAsOf: "live-test", dealId, status: "CAPTURED" });
  expect(first?.updateAuthority).toBe(signer);
  const upd = await updatePassportStatus(made.address, "RECALLED_AFTER_SALE", { recall: "LIVE-TEST" });
  console.log("[live] update:", JSON.stringify(upd));
  expect(upd.ok).toBe(true);
  const second = await readUntil(made.address, "RECALLED_AFTER_SALE");
  console.log("[live] read 2:", JSON.stringify(second));
  expect(second?.attributes).toEqual({ verdict: "LIVE_TEST", recordSha256: sha, indexAsOf: "live-test", dealId, status: "RECALLED_AFTER_SALE", recall: "LIVE-TEST" });
}, 120_000);
