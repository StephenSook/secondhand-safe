import type { Metadata } from "next";
import { connection } from "next/server";
import { Nav } from "@/ui/Nav";
import { AutoRefresh } from "@/ui/AutoRefresh";
import { BRAND } from "@/core/brand";
import { trustStats, type TrustStats } from "@/server/deals/trust";

export const metadata: Metadata = { title: `Trust and Safety console: ${BRAND}` };

const OUTCOMES: { key: string; label: string; color: string }[] = [
  { key: "CAPTURED", label: "Paid to the seller after a clean label", color: "var(--green)" },
  { key: "REVERSED", label: "Reversed: recalled or banned at pickup", color: "var(--red)" },
  { key: "HELD", label: "Held right now, waiting for pickup", color: "var(--amber)" },
  { key: "RELEASED", label: "Released: pickup never happened", color: "var(--aqua)" },
  { key: "LAPSED", label: "Lapsed at Visa (never captured)", color: "var(--sand)" },
  { key: "REFUSED", label: "Visa refused a settlement", color: "var(--sand)" },
  { key: "UNKNOWN", label: "Unconfirmed", color: "var(--sand)" },
];
const CARD: Record<string, string> = {
  microform: "Visa Microform (card typed into Visa's field)", "saved-card": "Visa Token Management Service (saved card)",
  "sandbox-test-card": "Visa sandbox test card (agent path)", unknown: "Not recorded",
};
/** 42 s, 7 min, 2.5 h */
const dur = (sec: number) => (sec < 90 ? `${sec} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${Math.round(sec / 360) / 10} h`);
const usd = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Bars({ s }: { s: TrustStats }) {
  const rows = OUTCOMES.filter((o) => s.byStatus[o.key]?.n);
  const max = Math.max(1, ...rows.map((o) => s.byStatus[o.key].n));
  return (
    <ul className="grid gap-3" aria-label="Deals by outcome">
      {rows.map((o) => {
        const v = s.byStatus[o.key];
        return (
          <li key={o.key} className="grid grid-cols-[minmax(0,15rem)_1fr_auto] items-center gap-3">
            <span className="text-sm font-bold">{o.label}</span>
            <span className="h-7 rounded-full border-2 border-ink bg-paper overflow-hidden" aria-hidden>
              <span className="block h-full" style={{ width: `${(v.n / max) * 100}%`, background: o.color }} />
            </span>
            <span className="font-extrabold tabular-nums text-right">{v.n} · {usd(v.usd)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Hourly({ s }: { s: TrustStats }) {
  const max = Math.max(1, ...s.hourly.map((h) => h.n));
  const W = 24 * 14;
  return (
    <svg viewBox={`0 0 ${W} 90`} className="w-full h-28" role="img" aria-label={`Holds created per hour over the last 24 hours, peak ${max}`}>
      {s.hourly.map((h, i) => {
        const hgt = (h.n / max) * 70;
        return <rect key={h.hour} x={i * 14 + 2} y={80 - hgt} width={10} height={Math.max(hgt, 1)} rx={2} fill={h.n ? "var(--ink)" : "var(--sand)"}><title>{`${h.hour}:00 UTC: ${h.n}`}</title></rect>;
      })}
      <line x1="0" y1="80.5" x2={W} y2="80.5" stroke="var(--ink)" strokeWidth="1" />
      <text x="0" y="90" fontSize="8" fill="currentColor">24 h ago</text>
      <text x={W} y="90" fontSize="8" textAnchor="end" fill="currentColor">now</text>
    </svg>
  );
}

/**
 * Trust and Safety console (PLAN 5.8): what a marketplace's trust and safety and payments teams would watch.
 * Rendered on every request from MongoDB Atlas; no number on this page is typed in.
 */
export default async function TrustPage() {
  await connection();
  const s = await trustStats();
  return (
    <>
      <Nav />
      <main className="px-3 pt-3 pb-3">
        <section className="section-card bg-sand px-5 sm:px-12 pt-28 pb-16">
          <p className="hand text-3xl text-ink/70 -rotate-2 mb-3">what a marketplace safety team would watch</p>
          <h1 className="display text-[clamp(2.4rem,5.5vw,5rem)]">Trust and Safety console</h1>
          {!s ? (
            <p className="mt-6 rounded-2xl border-[3px] border-ink bg-paper p-5 font-bold">MongoDB Atlas did not answer, so no numbers are shown. Nothing here is ever made up; try again in a moment.</p>
          ) : (
            <div className="grid gap-6 mt-8">
              <AutoRefresh everyMs={10_000} times={90} />
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="rounded-[2rem] border-[3px] border-ink bg-red text-paper p-5">
                  <p className="display text-4xl">{usd(s.keptFromBadItemsUsd)}</p>
                  <p className="font-bold">never reached a seller of a recalled or banned item</p>
                </div>
                <div className="rounded-[2rem] border-[3px] border-ink bg-green text-paper p-5">
                  <p className="display text-4xl">{usd(s.byStatus.CAPTURED?.usd ?? 0)}</p>
                  <p className="font-bold">paid to sellers after the label passed</p>
                </div>
                <div className="rounded-[2rem] border-[3px] border-ink bg-amber p-5">
                  <p className="display text-4xl">{s.byStatus.HELD?.n ?? 0}</p>
                  <p className="font-bold">holds waiting for a pickup scan</p>
                </div>
                <div className="rounded-[2rem] border-[3px] border-ink bg-paper p-5">
                  <p className="display text-4xl">{s.decisionSeconds.median === null ? "none yet" : dur(s.decisionSeconds.median)}</p>
                  <p className="font-bold">median time from hold to decision ({s.decisionSeconds.n} settled{s.decisionSeconds.p90 !== null ? `, p90 ${dur(s.decisionSeconds.p90)}` : ""})</p>
                </div>
              </div>

              {Object.keys(s.payouts).length > 0 && (
                <div data-testid="payouts" className="rounded-[2rem] border-[3px] border-ink bg-paper p-6">
                  <h2 className="display text-2xl mb-2">Sellers paid with Visa Direct</h2>
                  <p className="font-semibold">
                    {usd(s.payouts.SENT?.usd ?? 0)} pushed to sellers after capture ({s.payouts.SENT?.n ?? 0} sent
                    {s.payouts.UNCERTAIN?.n ? `, ${s.payouts.UNCERTAIN.n} not yet confirmed` : ""}
                    {s.payouts.FAILED?.n ? `, ${s.payouts.FAILED.n} failed` : ""}). Visa Developer sandbox, paid to Visa&apos;s sandbox test recipient card.
                  </p>
                </div>
              )}

              <div className="rounded-[2rem] border-[3px] border-ink bg-paper p-6">
                <h2 className="display text-2xl mb-4">Every hold, by how it ended ({s.deals})</h2>
                <Bars s={s} />
              </div>

              <div className="grid lg:grid-cols-2 gap-6">
                <div className="rounded-[2rem] border-[3px] border-ink bg-paper p-6">
                  <h2 className="display text-2xl mb-3">Why holds were reversed</h2>
                  {s.reversalReasons.length === 0 ? <p className="font-semibold">No reversals yet.</p> : (
                    <table className="w-full text-left">
                      <thead><tr className="text-sm"><th className="pb-2">Reason</th><th className="pb-2 text-right">Deals</th><th className="pb-2 text-right">Kept</th></tr></thead>
                      <tbody>
                        {s.reversalReasons.map((r) => (
                          <tr key={`${r.reason}${r.recall}`} className="border-t-2 border-ink/10 font-semibold">
                            <td className="py-2">{r.reason}</td>
                            <td className="py-2 text-right tabular-nums">{r.n}</td>
                            <td className="py-2 text-right tabular-nums">{usd(r.usd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div className="rounded-[2rem] border-[3px] border-ink bg-paper p-6">
                  <h2 className="display text-2xl mb-3">Holds per hour, last 24 hours</h2>
                  <Hourly s={s} />
                </div>
              </div>

              <div className="grid lg:grid-cols-2 gap-6">
                <div className="rounded-[2rem] border-[3px] border-ink bg-paper p-6">
                  <h2 className="display text-2xl mb-3">Who checked out</h2>
                  <p className="font-semibold">{s.bySource.agent} by the shopping agent (every request signed with the Trusted Agent Protocol) · {s.bySource.person} by a person</p>
                </div>
                <div className="rounded-[2rem] border-[3px] border-ink bg-paper p-6">
                  <h2 className="display text-2xl mb-3">How the card arrived</h2>
                  <ul className="grid gap-1 font-semibold">
                    {Object.entries(s.byCard).sort((a, b) => b[1] - a[1]).map(([k, n]) => <li key={k}>{CARD[k] ?? k}: {n}</li>)}
                  </ul>
                </div>
              </div>

              <p className="text-sm font-semibold text-ink/70">
                Computed from the deal records in MongoDB Atlas at {new Date(s.asOf).toUTCString()}, refreshed every 10 seconds.
                These deals are our own: demo purchases and our automated end-to-end tests, which run against this live site
                on every code change. Visa Acceptance sandbox, no real money. No card data or Visa ids are shown here.
              </p>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
