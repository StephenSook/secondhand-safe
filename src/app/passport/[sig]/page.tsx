import type { Metadata } from "next";
import { Nav } from "@/ui/Nav";
import { BRAND } from "@/core/brand";
import { readPassport, recordHash } from "@/server/solana/memo";

export const metadata: Metadata = { title: `Item passport: ${BRAND}` };

/** A stranger can check this: the page reads the memo from Solana devnet and recomputes the record's hash. */
export default async function PassportPage({ params, searchParams }: { params: Promise<{ sig: string }>; searchParams: Promise<{ r?: string }> }) {
  const { sig } = await params;
  const { r } = await searchParams;
  const valid = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig);
  const tx = valid ? await readPassport(sig).catch(() => null) : null;
  let record: Record<string, unknown> | null = null;
  let json = "";
  try { if (r) { json = Buffer.from(r, "base64url").toString("utf8"); record = JSON.parse(json); } } catch { record = null; }
  const onChain = tx?.memo?.match(/record=sha256:([0-9a-f]{64})/)?.[1] ?? null;
  const matches = !!(record && onChain && recordHash(json) === onChain);
  const explorer = `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  return (
    <>
      <Nav />
      <main className="px-3 pt-3 pb-3">
        <section className="section-card bg-aqua-soft px-5 sm:px-12 pt-28 pb-16">
          <p className="hand text-3xl text-teal -rotate-2">the item&apos;s check, on a public chain</p>
          <h1 className="display text-[clamp(2.4rem,5.5vw,5rem)] mt-2">Item passport</h1>
          <div className={`mt-8 rounded-[2rem] border-[3px] border-ink p-6 ${matches ? "bg-green-soft" : "bg-paper"}`}>
            <p className="text-sm font-extrabold tracking-wider">SOLANA DEVNET · MEMO</p>
            {!valid && <p className="display text-3xl mt-1">Not a transaction signature</p>}
            {valid && !tx && <p className="display text-3xl mt-1">Not found on devnet (yet)</p>}
            {tx && (
              <>
                <p className="display text-3xl mt-1">{matches ? "✓ Record matches the chain" : record ? "✕ Record does NOT match the chain" : "On chain; no record attached to this link"}</p>
                <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm">
                  <dt>memo</dt><dd className="break-all">{tx.memo ?? "(none)"}</dd>
                  <dt>slot</dt><dd>{tx.slot}</dd>
                  <dt>time</dt><dd>{tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "unknown"}</dd>
                  <dt>record hash</dt><dd className="break-all">{json ? recordHash(json) : "no record"}</dd>
                </dl>
              </>
            )}
            <a href={explorer} target="_blank" rel="noreferrer" className="mt-4 inline-block font-bold underline">Open in Solana Explorer (devnet)</a>
          </div>
          {record && (
            <div className="mt-6 rounded-[2rem] border-[3px] border-ink bg-paper p-6">
              <p className="text-sm font-extrabold tracking-wider">THE PICKUP CHECK THIS PASSPORT PROVES</p>
              <pre className="mt-3 whitespace-pre-wrap break-all text-sm">{JSON.stringify(record, null, 2)}</pre>
              <p className="mt-3 text-xs font-semibold text-ink/60">
                Recompute it yourself: SHA-256 of the record text equals the hash in the memo. The recall index can change;
                this proves what the check said at the time of sale, not that the item is safe.
              </p>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
