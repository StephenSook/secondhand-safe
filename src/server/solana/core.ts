import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { generateSigner, keypairIdentity, publicKey, type Umi } from "@metaplex-foundation/umi";
import { base58 } from "@metaplex-foundation/umi/serializers";
import { create, fetchAsset, mplCore, safeFetchAssetV1, updatePlugin } from "@metaplex-foundation/mpl-core";
import { DEVNET_RPC } from "./memo";
import { DEAL_ID_RE } from "./meta";

export { DEAL_ID_RE };

/**
 * Item passport as a real on-chain asset (PLAN 6.4): one Metaplex Core asset per captured sale on Solana devnet,
 * whose Attributes plugin holds { verdict, recordSha256, indexAsOf, dealId, status }. The Memo transaction
 * (memo.ts) stays the audit trail; this asset is the thing a wallet or explorer can show, and the recall watch
 * updates its `status` to RECALLED_AFTER_SALE when a recall is announced after the sale.
 *
 * Custodial: our passport key is payer, update authority and owner. Nothing here throws to its caller; every
 * outcome comes back as a result, because this always runs after the money has already moved.
 */
export const PASSPORT_STATUSES = ["CAPTURED", "RECALLED_AFTER_SALE"] as const;
export type PassportStatus = (typeof PASSPORT_STATUSES)[number];
/** A new asset costs about 0.005 SOL (protocol fee plus rent); below this we refuse instead of half-failing. */
export const MIN_BALANCE_LAMPORTS = 20_000_000n; // 0.02 SOL
/** Our own deadline on a send: the RPC's blockhash-expiry wait can outlast a serverless function. */
export const SEND_DEADLINE_MS = 40_000;

export interface PassportFields { verdict: string; recordSha256: string; indexAsOf: string; dealId: string; status: PassportStatus }
export type Attr = { key: string; value: string };
export type CoreResult =
  | { ok: true; address: string; signature: string | null }
  | { ok: false; reason: string; address?: string };

export const ASSET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const explorerAddress = (addr: string) => `https://explorer.solana.com/address/${addr}?cluster=devnet`;

/** The Attributes plugin list for a passport, in a fixed order. Refuses malformed input instead of writing it on chain. */
export function passportAttributes(f: PassportFields): Attr[] {
  if (!DEAL_ID_RE.test(f.dealId)) throw new Error("dealId is not a deal id");
  if (!/^[0-9a-f]{64}$/.test(f.recordSha256)) throw new Error("recordSha256 must be 64 lowercase hex characters");
  if (!PASSPORT_STATUSES.includes(f.status)) throw new Error(`unknown passport status ${String(f.status)}`);
  if (!f.verdict || f.verdict.length > 40) throw new Error("verdict must be 1 to 40 characters");
  return [
    { key: "verdict", value: f.verdict },
    { key: "recordSha256", value: f.recordSha256 },
    { key: "indexAsOf", value: (f.indexAsOf || "unknown").slice(0, 40) },
    { key: "dealId", value: f.dealId },
    { key: "status", value: f.status },
  ];
}

/** updatePlugin REPLACES the whole list, so an update is always a merge: changed keys in place, new keys appended,
 *  every other attribute kept exactly as it was on chain. */
export function mergeAttributes(existing: readonly Attr[], changes: Record<string, string>): Attr[] {
  const out = existing.map((a) => (Object.hasOwn(changes, a.key) ? { key: a.key, value: changes[a.key] } : { key: a.key, value: a.value }));
  for (const [key, value] of Object.entries(changes)) if (!out.some((a) => a.key === key)) out.push({ key, value });
  return out;
}

export const attributesToRecord = (list: readonly Attr[] | undefined) => Object.fromEntries((list ?? []).map((a) => [a.key, a.value]));

/** A umi client on devnet with Core registered and our passport key as identity and payer. Throws on a bad key. */
export function passportUmi(secretB58: string, rpcUrl = DEVNET_RPC): Umi {
  const umi = createUmi(rpcUrl).use(mplCore());
  const secret = base58.serialize(secretB58.trim());
  if (secret.length !== 64) throw new Error("SOLANA_SECRET_KEY_B58 must be a 64-byte keypair");
  return umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(secret)));
}

export function umiFromEnv(): Umi | { reason: string } {
  const sec = process.env.SOLANA_SECRET_KEY_B58?.trim();
  if (!sec) return { reason: "SOLANA_SECRET_KEY_B58 is not configured" };
  try { return passportUmi(sec); } catch (e) { return { reason: `passport key unusable: ${(e as Error).message}` }; }
}

export const deadline = <T>(p: Promise<T>, ms: number, what: string) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, bad) => { t = setTimeout(() => bad(new Error(`${what} timed out after ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(t));
};

/** Refuses (returns a reason) when the payer holds less than MIN_BALANCE_LAMPORTS or the balance cannot be read. */
export async function balanceRefusal(umi: Umi, reserve = 0n): Promise<string | null> {
  try {
    const bal = await deadline(umi.rpc.getBalance(umi.identity.publicKey), 8_000, "getBalance");
    // `reserve` is what the next transaction may spend, so the wallet stays at or above the floor AFTER it
    if (bal.basisPoints < MIN_BALANCE_LAMPORTS + reserve) {
      return `passport wallet holds ${Number(bal.basisPoints) / 1e9} SOL, below the 0.02 SOL floor${reserve ? ` plus ${Number(reserve) / 1e9} SOL for this mint` : ""}`;
    }
    return null;
  } catch (e) {
    return `could not read the passport wallet balance: ${(e as Error).message}`;
  }
}

/** Outcome of one create send. "uncertain" means it may still have landed: never re-send with a new address. */
export type SendOutcome = { kind: "ok"; signature: string } | { kind: "failed"; reason: string } | { kind: "uncertain"; reason: string };

/**
 * Sends the create for one captured sale with a signer the caller generated (and persisted) first, so the address is
 * known before anything leaves this server. A thrown error or a timeout is "uncertain": the transaction may land.
 */
export async function sendCreate(umi: Umi, asset: ReturnType<typeof generateSigner>, f: PassportFields, baseUrl: string): Promise<SendOutcome> {
  let attributeList: Attr[];
  try { attributeList = passportAttributes(f); } catch (e) { return { kind: "failed", reason: (e as Error).message }; }
  try {
    const res = await deadline(create(umi, {
      asset,
      name: `Lullabuy passport ${f.dealId}`,
      uri: `${baseUrl.replace(/\/+$/, "")}/api/passport-meta/${f.dealId}`,
      plugins: [{ type: "Attributes", attributeList }],
    }).sendAndConfirm(umi), SEND_DEADLINE_MS, "create");
    if (res.result.value.err) return { kind: "failed", reason: `create failed on chain: ${JSON.stringify(res.result.value.err)}` };
    return { kind: "ok", signature: base58.deserialize(res.signature)[0] };
  } catch (e) {
    console.warn(`[core-passport] create for ${f.dealId} unconfirmed (it may still land at ${asset.publicKey.toString()}):`, (e as Error).message);
    return { kind: "uncertain", reason: (e as Error).message };
  }
}

export const newAssetSigner = (umi: Umi) => generateSigner(umi);

/** Sets the passport's `status` (and any extra attributes), keeping every other attribute on the asset. */
export async function updatePassportStatus(assetAddress: string, status: PassportStatus, extra: Record<string, string> = {}, umiIn?: Umi): Promise<CoreResult> {
  if (!ASSET_RE.test(assetAddress)) return { ok: false, reason: "not an asset address" };
  if (!PASSPORT_STATUSES.includes(status)) return { ok: false, reason: `unknown passport status ${String(status)}` };
  const umi = umiIn ?? umiFromEnv();
  if (!("rpc" in umi)) return { ok: false, reason: umi.reason };
  const low = await balanceRefusal(umi);
  if (low) { console.warn(`[core-passport] refused: ${low}`); return { ok: false, reason: low }; }
  try {
    const asset = await deadline(fetchAsset(umi, publicKey(assetAddress)), 10_000, "fetchAsset");
    const current = asset.attributes?.attributeList ?? [];
    const attributeList = mergeAttributes(current, { ...extra, status });
    // read before write: an earlier update that timed out may have landed; if the chain already says this, send nothing
    if (JSON.stringify(attributeList) === JSON.stringify(current.map((a) => ({ key: a.key, value: a.value })))) {
      return { ok: true, address: assetAddress, signature: null };
    }
    const res = await deadline(updatePlugin(umi, { asset: asset.publicKey, plugin: { type: "Attributes", attributeList } }).sendAndConfirm(umi),
      SEND_DEADLINE_MS, "updatePlugin");
    if (res.result.value.err) return { ok: false, reason: `update failed on chain: ${JSON.stringify(res.result.value.err)}`, address: assetAddress };
    return { ok: true, address: assetAddress, signature: base58.deserialize(res.signature)[0] };
  } catch (e) {
    console.warn(`[core-passport] status update not written for ${assetAddress}:`, (e as Error).message);
    return { ok: false, reason: `not written: ${(e as Error).message}`, address: assetAddress };
  }
}

export interface PassportAssetView { address: string; name: string; uri: string; owner: string; updateAuthority: string | null; attributes: Record<string, string> }

/** Reads an asset back. null when devnet says it does not exist; an RPC failure throws (the page says so). */
export async function readPassportAsset(address: string, umi: Umi = createUmi(DEVNET_RPC).use(mplCore())): Promise<PassportAssetView | null> {
  if (!ASSET_RE.test(address)) return null;
  const a = await deadline(safeFetchAssetV1(umi, publicKey(address)), 8_000, "fetch asset");
  if (!a) return null;
  return {
    address, name: a.name, uri: a.uri, owner: a.owner.toString(),
    updateAuthority: a.updateAuthority.type === "Address" && a.updateAuthority.address ? a.updateAuthority.address.toString() : null,
    attributes: attributesToRecord(a.attributes?.attributeList),
  };
}

/** What the passport page shows as the asset's verdict: ours, same deal, same record hash, and the same recall state as
 *  the deal record. A recall the deal knows about but the chain does not (or the reverse) is never shown as verified. */
export function judgeAsset(a: PassportAssetView, expectedSigner: string | null, recordSha256: string | null, dealId: string | null, dealRecall: string | null = null) {
  const fromUs = !!expectedSigner && a.updateAuthority === expectedSigner;
  const hashOk = !!recordSha256 && a.attributes.recordSha256 === recordSha256;
  const dealOk = !!dealId && a.attributes.dealId === dealId;
  const recallOk = dealRecall
    ? a.attributes.status === "RECALLED_AFTER_SALE" && a.attributes.recall === dealRecall
    : a.attributes.status === "CAPTURED" && !Object.hasOwn(a.attributes, "recall");
  return { fromUs, hashOk, dealOk, recallOk, verified: fromUs && hashOk && dealOk && recallOk };
}
