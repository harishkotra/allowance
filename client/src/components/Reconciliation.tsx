import type { ReconSide, Reconciliation as Recon } from "../../../shared/types";
import { fmtTokens, fmtUsd } from "../lib/api";

function Cells({ side }: { side: ReconSide }) {
  return (
    <>
      <td className="tabular px-2 py-1.5 text-right">{fmtTokens(side.inputTokens)}</td>
      <td className="tabular px-2 py-1.5 text-right">{fmtTokens(side.outputTokens)}</td>
      <td className="tabular px-2 py-1.5 text-right">{fmtTokens(side.totalTokens)}</td>
      <td className="tabular px-2 py-1.5 text-right">{fmtUsd(side.usd)}</td>
      <td className="tabular px-2 py-1.5 text-right">{side.calls}</td>
    </>
  );
}

export default function Reconciliation({ recon }: { recon: Recon }) {
  const signed = (value: number, money = false) => {
    if (value === 0) return "0";
    return `${value > 0 ? "+" : "−"}${money ? fmtUsd(Math.abs(value)) : fmtTokens(Math.abs(value))}`;
  };

  return (
    <section aria-label="Reconciliation">
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-muted)]">Reconciliation</h2>
        <span
          className={`rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
            recon.reconciles
              ? "bg-[#12291f] text-[var(--color-ok)]"
              : "bg-[#2a1416] text-[var(--color-bad)]"
          }`}
        >
          {recon.reconciles ? "reconciles" : "does not reconcile"}
        </span>
      </header>

      <div className="overflow-hidden rounded-lg border border-[var(--color-edge)]">
        <table className="w-full text-xs">
          <thead className="bg-[#151a21] text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
            <tr>
              <th className="px-2 py-2 text-left">source</th>
              <th className="px-2 py-2 text-right">in</th>
              <th className="px-2 py-2 text-right">out</th>
              <th className="px-2 py-2 text-right">tokens</th>
              <th className="px-2 py-2 text-right">$</th>
              <th className="px-2 py-2 text-right">calls</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-edge)]">
            <tr className="bg-[#11161c]">
              <td className="px-2 py-1.5 font-semibold text-neutral-200">Ledger charged (all rows)</td>
              <Cells side={recon.ledger} />
            </tr>
            <tr>
              <td className="px-2 py-1.5 pl-5 text-neutral-400">
                · provider-reported rows ({recon.ledger.reportedCalls})
              </td>
              <td className="tabular px-2 py-1.5 text-right" colSpan={3}>
                {fmtTokens(recon.providerReported.totalTokens)}
              </td>
              <td className="tabular px-2 py-1.5 text-right">{fmtUsd(recon.reportedUsd)}</td>
              <td className="tabular px-2 py-1.5 text-right">{recon.ledger.reportedCalls}</td>
            </tr>
            <tr>
              <td className="px-2 py-1.5 pl-5 text-[var(--color-warn)]">
                · tokeniser estimates, labelled ({recon.ledger.estimatedCalls})
              </td>
              <td className="tabular px-2 py-1.5 text-right" colSpan={3}>
                {fmtTokens(recon.ledger.totalTokens - recon.providerReported.totalTokens)}
              </td>
              <td className="tabular px-2 py-1.5 text-right">{fmtUsd(recon.estimatedUsd)}</td>
              <td className="tabular px-2 py-1.5 text-right">{recon.ledger.estimatedCalls}</td>
            </tr>
            <tr>
              <td className="px-2 py-1.5 text-neutral-300">Provider-reported totals (re-summed from raw payloads)</td>
              <Cells side={recon.providerReported} />
            </tr>
            <tr>
              <td className="px-2 py-1.5 text-neutral-300">Tokeniser estimate for every call</td>
              <Cells side={recon.tokeniserAll} />
            </tr>
            <tr className="bg-[#151a21] font-semibold">
              <td className="px-2 py-1.5 text-neutral-200">Delta (ledger − provider, attested rows)</td>
              <td className="tabular px-2 py-1.5 text-right">{signed(recon.delta.inputTokens)}</td>
              <td className="tabular px-2 py-1.5 text-right">{signed(recon.delta.outputTokens)}</td>
              <td className="tabular px-2 py-1.5 text-right">{signed(recon.delta.totalTokens)}</td>
              <td className="tabular px-2 py-1.5 text-right">{signed(recon.delta.usd, true)}</td>
              <td className="px-2 py-1.5" />
            </tr>
          </tbody>
        </table>
      </div>

      <ul className="mt-2 flex flex-col gap-1 text-[11px] text-[var(--color-muted)]">
        {recon.reasons.map((reason) => (
          <li key={reason}>• {reason}</li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-[var(--color-muted)]">
        Envelope counters {recon.countersMatchLedger ? "match" : "DO NOT match"} the sum of ledger rows.
      </p>
    </section>
  );
}
