import { describe, it, expect } from "vitest";
import { createPublicKey, verify, randomBytes, generateKeyPairSync } from "node:crypto";
import { b58encode, b58decode, buildMemoTx, keypairFromB58, passportMemo, recordHash, MEMO_PROGRAM, judgePassport, passportSigner, readPassport } from "@/server/solana/memo";

function freshSecret() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
  const pub = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  return b58encode(Buffer.concat([seed, pub]));
}

describe("Solana memo passport (hand-built transaction)", () => {
  it("base58 round-trips, including leading zeros, and decodes the Memo program id to 32 bytes", () => {
    const b = Buffer.concat([Buffer.alloc(2), randomBytes(30)]);
    expect(b58decode(b58encode(b)).equals(b)).toBe(true);
    expect(b58decode(MEMO_PROGRAM).length).toBe(32);
  });
  it("signs the exact message bytes with the payer key", () => {
    const kp = keypairFromB58(freshSecret());
    const { tx, signature } = buildMemoTx(kp, b58encode(randomBytes(32)), passportMemo("shs-abc", recordHash("{}")));
    const raw = Buffer.from(tx, "base64");
    expect(raw[0]).toBe(1); // one signature
    const sig = raw.subarray(1, 65), message = raw.subarray(65);
    expect(b58encode(sig)).toBe(signature);
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: kp.pub.toString("base64url") }, format: "jwk" });
    expect(verify(null, message, pub, sig)).toBe(true);
    expect(message.subarray(0, 3).equals(Buffer.from([1, 0, 1]))).toBe(true);
    expect(message.includes(Buffer.from("record=sha256:"))).toBe(true);
  });
  it("the memo carries only a hash, never the record", () => {
    const rec = JSON.stringify({ dealId: "shs-abc", verdict: "NO_MATCH", model: "ZZT9Q41X" });
    const m = passportMemo("shs-abc", recordHash(rec));
    expect(m).not.toContain("ZZT9Q41X");
    expect(m).toMatch(/sha256:[0-9a-f]{64}$/);
  });

  it("a passport verifies only with our signer, a successful transaction and the matching record", () => {
    const rec = JSON.stringify({ dealId: "shs-1", verdict: "NO_MATCH" });
    const memo = passportMemo("shs-1", recordHash(rec));
    expect(judgePassport({ memo, ok: true, signer: "OURS" }, "OURS", rec).verified).toBe(true);
    // anyone can post the same memo from their own wallet
    expect(judgePassport({ memo, ok: true, signer: "ATTACKER" }, "OURS", rec)).toMatchObject({ verified: false, fromUs: false, hashOk: true });
    expect(judgePassport({ memo, ok: false, signer: "OURS" }, "OURS", rec).verified).toBe(false);
    expect(judgePassport({ memo, ok: true, signer: "OURS" }, "OURS", rec.replace("NO_MATCH", "RECALL_MATCH")).verified).toBe(false);
    expect(judgePassport({ memo, ok: true, signer: "OURS" }, null, rec).verified).toBe(false);
  });
  it("the expected signer comes from our keypair, or the public SOLANA_PUBKEY", () => {
    const secret = freshSecret();
    expect(passportSigner({ SOLANA_SECRET_KEY_B58: secret })).toBe(b58encode(keypairFromB58(secret).pub));
    expect(passportSigner({ SOLANA_PUBKEY: "PUB" })).toBe("PUB");
    expect(passportSigner({})).toBeNull();
  });
  it("an RPC failure throws; only a real 'no such transaction' is null", async () => {
    const none = (async () => Response.json({ jsonrpc: "2.0", id: 1, result: null })) as unknown as typeof fetch;
    expect(await readPassport("x", none)).toBeNull();
    const busy = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    await expect(readPassport("x", busy)).rejects.toThrow();
  });
});
