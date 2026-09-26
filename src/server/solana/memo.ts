import { createHash, createPrivateKey, sign } from "node:crypto";

/**
 * Item passport on Solana devnet (PLAN 3.12): a Memo-program transaction whose memo carries the SHA-256 of the
 * pickup verification record. Built by hand (legacy message, one Memo v2 instruction signed by the payer), so it
 * needs no SDK. Only the hash goes on chain; the record itself travels in the passport link and anyone can
 * recompute the hash against the chain.
 */
export const DEVNET_RPC = "https://api.devnet.solana.com";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58encode(b: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(b).toString("hex") || "0"));
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = "1" + s; }
  return s;
}

export function b58decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let zeros = 0;
  for (const c of s) { if (c !== "1") break; zeros++; }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

const compactU16 = (n: number) => {
  const out: number[] = [];
  for (;;) { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); if (!n) return Buffer.from(out); }
};

const PKCS8_ED25519 = "302e020100300506032b657004220420";
export function keypairFromB58(secretB58: string) {
  const raw = b58decode(secretB58.trim());
  if (raw.length !== 64) throw new Error("SOLANA_SECRET_KEY_B58 must be a 64-byte keypair");
  return { priv: createPrivateKey({ key: Buffer.from(PKCS8_ED25519 + raw.subarray(0, 32).toString("hex"), "hex"), format: "der", type: "pkcs8" }), pub: raw.subarray(32) };
}

/** Legacy transaction: header [1 signer, 0 readonly signed, 1 readonly unsigned], keys [payer, memo], one instruction. */
export function buildMemoTx(kp: ReturnType<typeof keypairFromB58>, blockhashB58: string, memo: string) {
  const data = Buffer.from(memo, "utf8");
  if (data.length > 500) throw new Error("memo too long");
  const message = Buffer.concat([
    Buffer.from([1, 0, 1]),
    compactU16(2), kp.pub, b58decode(MEMO_PROGRAM),
    b58decode(blockhashB58),
    compactU16(1), Buffer.from([1]), compactU16(1), Buffer.from([0]), compactU16(data.length), data,
  ]);
  const sig = sign(null, message, kp.priv);
  return { tx: Buffer.concat([compactU16(1), sig, message]).toString("base64"), signature: b58encode(sig) };
}

async function rpc<T>(method: string, params: unknown[], f: typeof fetch, timeoutMs = 10_000, url = DEVNET_RPC): Promise<T> {
  const r = await f(url, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json().catch(() => ({}))) as { result?: T; error?: { message?: string } };
  if (!r.ok || j.error || j.result === undefined) throw new Error(j.error?.message ?? `Solana RPC HTTP ${r.status}`);
  return j.result;
}

export const recordHash = (recordJson: string) => createHash("sha256").update(recordJson, "utf8").digest("hex");
export const passportMemo = (dealId: string, hashHex: string) => `lullabuy passport v1 deal=${dealId} record=sha256:${hashHex}`;

/** Sends the memo; returns the transaction signature. Throws with Solana's reason (for example an unfunded payer). */
export async function anchor(secretB58: string, memo: string, f: typeof fetch = fetch): Promise<string> {
  const kp = keypairFromB58(secretB58);
  // short timeouts: this runs after the Visa capture, and must never make a finished sale look failed
  const { value } = await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }], f, 3_000);
  const { tx } = buildMemoTx(kp, value.blockhash, memo);
  return rpc<string>("sendTransaction", [tx, { encoding: "base64", preflightCommitment: "confirmed" }], f, 4_000);
}

/** The public key that signs our passports: from the keypair when this server holds it, else SOLANA_PUBKEY. */
export function passportSigner(env: Record<string, string | undefined> = process.env): string | null {
  const sec = env.SOLANA_SECRET_KEY_B58?.trim();
  if (sec) { try { return b58encode(keypairFromB58(sec).pub); } catch (e) { console.warn("[passport] SOLANA_SECRET_KEY_B58 is malformed:", (e as Error).message); } }
  return env.SOLANA_PUBKEY?.trim() || null;
}

/** Dry run against devnet with signature verification on: proves the transaction is well formed and signed. */
export async function simulate(secretB58: string, memo: string, f: typeof fetch = fetch) {
  const kp = keypairFromB58(secretB58);
  const { value } = await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }], f);
  const { tx } = buildMemoTx(kp, value.blockhash, memo);
  return rpc<{ value: { err: unknown; logs: string[] | null } }>("simulateTransaction", [tx, { encoding: "base64", sigVerify: true, commitment: "confirmed" }], f);
}

/** Reads a passport transaction back: memo text, fee payer (the signer), success, slot and time.
 *  Returns null only when devnet answers that the transaction does not exist; an RPC failure throws. */
export async function readPassport(signature: string, f: typeof fetch = fetch) {
  const t = await rpc<{ slot: number; blockTime: number | null; meta: { logMessages: string[] | null; err: unknown };
    transaction: { message: { accountKeys: string[] } } } | null>(
    "getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }], f);
  if (!t) return null;
  const line = (t.meta.logMessages ?? []).find((l) => l.includes("Memo (len"));
  const memo = line?.match(/: "(.*)"$/)?.[1] ?? null;
  return { slot: t.slot, blockTime: t.blockTime, memo, ok: t.meta.err === null, signer: t.transaction.message.accountKeys[0] ?? null };
}

/** The passport verdict a stranger sees: all three must hold, or it is not ours or not proven. */
export function judgePassport(tx: { memo: string | null; ok: boolean; signer: string | null }, expectedSigner: string | null, recordJson: string | null) {
  const onChain = tx.memo?.match(/record=sha256:([0-9a-f]{64})/)?.[1] ?? null;
  const fromUs = !!expectedSigner && tx.signer === expectedSigner;
  const hashOk = !!recordJson && !!onChain && recordHash(recordJson) === onChain;
  return { fromUs, succeeded: tx.ok, hashOk, verified: fromUs && tx.ok && hashOk };
}
