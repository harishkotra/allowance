import type { LedgerRow } from "../../../shared/types";
import { fmtPct, fmtTime, fmtTokens, fmtUsd } from "../lib/api";

function EstimatedBadge({ estimated }: { estimated: boolean }) {
  return estimated ? (
    <span
      title="Provider returned no usage; charged with a tokeniser estimate"
      className="rounded bg-[#3a2f14] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-warn)]"
    >
      est
    </span>
  ) : (
    <span
      title="Provider-reported usage"
      className="rounded bg-[#12291f] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ok)]"
    >
      reported
    </span>
  );
}

export default function Ledger({ rows, totals }: { rows: LedgerRow[]; totals: { tokens: number; usd: number; rows: number; estimatedRows: number } }) {
  return (
    <section aria-label="Ledger">
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-muted)]">Ledger</h2>
        <p className="text-xs text-[var(--color-muted)]">
          one row per executed step · totals recomputed from the database
        </p>
      </header>
      <div className="overflow-x-auto rounded-lg border border-[var(--color-edge)]">
        <table className="w-full min-w-[620px] text-[11px]">
          <thead className="bg-[#151a21] text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
            <tr>
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2">phase</th>
              <th className="px-2 py-2">step</th>
              <th className="px-2 py-2">model</th>
              <th className="px-2 py-2 text-right">in</th>
              <th className="px-2 py-2 text-right">out</th>
              <th className="px-2 py-2 text-right">$</th>
              <th className="px-2 py-2 text-right">cum %</th>
              <th className="px-2 py-2">source</th>
              <th className="px-2 py-2 text-right">timestamp</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-edge)]">
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-[var(--color-muted)]">
                  No steps executed yet.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.stepKey} className="hover:bg-[#161c24]">
                <td className="tabular px-2 py-2 text-[var(--color-muted)]">{row.step}</td>
                <td className="px-2 py-2">
                  <span className="rounded bg-[#1b222b] px-1.5 py-0.5 text-[10px] uppercase text-neutral-300">
                    {row.phase}
                  </span>
                </td>
                <td className="max-w-[150px] truncate px-2 py-2 text-neutral-300" title={row.action ?? row.stepKey}>
                  {row.action ?? row.stepKey}
                </td>
                <td className="max-w-[84px] truncate px-2 py-2 text-[var(--color-muted)]" title={row.model}>
                  {row.model}
                </td>
                <td className="tabular px-2 py-2 text-right">{fmtTokens(row.inputTokens)}</td>
                <td className="tabular px-2 py-2 text-right">{fmtTokens(row.outputTokens)}</td>
                <td className="tabular px-2 py-2 text-right">{fmtUsd(row.usd)}</td>
                <td className="tabular px-2 py-2 text-right">{fmtPct(row.cumulativePct)}</td>
                <td className="px-2 py-2">
                  <EstimatedBadge estimated={row.estimated} />
                </td>
                <td className="tabular px-2 py-2 text-right text-[var(--color-muted)]">{fmtTime(row.createdAt)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-[#151a21] font-semibold">
              <td className="px-2 py-2" colSpan={4}>
                Live total · {totals.rows} row(s) · {totals.estimatedRows} estimated
              </td>
              <td className="tabular px-2 py-2 text-right" colSpan={2}>
                {fmtTokens(totals.tokens)}
              </td>
              <td className="tabular px-2 py-2 text-right">{fmtUsd(totals.usd)}</td>
              <td className="px-2 py-2" colSpan={3} />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
