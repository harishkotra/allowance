import type { LedgerRow, Prices, ReconSide, Reconciliation, RunRow, RunState } from "../../shared/types";
import {
  getApprovalById,
  getLedger,
  getRun,
  listApprovals,
  listFindings,
  listNegotiations,
  listRuns,
} from "./db";
import { costUsd } from "./usage";
import { snapshotEnvelope } from "./agent/budget";

const emptySide = (): ReconSide => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, usd: 0, calls: 0 });

function addSide(side: ReconSide, input: number, output: number, usd: number): ReconSide {
  side.inputTokens += input;
  side.outputTokens += output;
  side.totalTokens += input + output;
  side.usd = round10(side.usd + usd);
  side.calls += 1;
  return side;
}

function round10(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}

/**
 * Ledger vs provider. Reported and estimated rows are summed separately and
 * never blended: the point of the table is to show which numbers the provider
 * actually attested to, and how far the estimates sit from them.
 */
export function reconcile(run: RunRow, rows: LedgerRow[]): Reconciliation {
  const prices: Prices = { per1kInput: run.per1kInput, per1kOutput: run.per1kOutput };

  const ledger = { ...emptySide(), estimatedCalls: 0, reportedCalls: 0 };
  const providerReported = emptySide();
  const tokeniserAll = emptySide();
  /** Only rows the provider attested to: charged vs reported must be identical. */
  const chargedReported = emptySide();
  let reportedUsd = 0;
  let estimatedUsd = 0;

  for (const row of rows) {
    addSide(ledger, row.inputTokens, row.outputTokens, row.usd);
    addSide(tokeniserAll, row.estInput, row.estOutput, costUsd(row.estInput, row.estOutput, prices));

    if (row.estimated) {
      ledger.estimatedCalls += 1;
      estimatedUsd += row.usd;
      continue;
    }

    ledger.reportedCalls += 1;
    reportedUsd += row.usd;
    addSide(chargedReported, row.inputTokens, row.outputTokens, row.usd);
    addSide(
      providerReported,
      row.reportedInput ?? row.inputTokens,
      row.reportedOutput ?? row.outputTokens,
      costUsd(row.reportedInput ?? row.inputTokens, row.reportedOutput ?? row.outputTokens, prices),
    );
  }

  ledger.usd = round10(ledger.usd);
  reportedUsd = round10(reportedUsd);
  estimatedUsd = round10(estimatedUsd);

  // What the ledger charged for attested rows minus what the provider reported
  // for exactly those rows. Zero means the ledger mirrors the provider.
  const delta = {
    inputTokens: chargedReported.inputTokens - providerReported.inputTokens,
    outputTokens: chargedReported.outputTokens - providerReported.outputTokens,
    totalTokens: chargedReported.totalTokens - providerReported.totalTokens,
    usd: round10(chargedReported.usd - providerReported.usd),
  };

  const countersMatchLedger =
    run.usedTokens === rows.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0) &&
    Math.abs(run.usedUsd - rows.reduce((sum, r) => sum + r.usd, 0)) < 1e-9 &&
    run.executedSteps === rows.length;

  const rowsMatchSteps = run.executedSteps === rows.length;
  const uniqueKeys = new Set(rows.map((r) => r.stepKey)).size === rows.length;

  const reasons: string[] = [];
  if (!countersMatchLedger) reasons.push("stored envelope counters do not equal the sum of ledger rows");
  if (!rowsMatchSteps) reasons.push("executed step count does not equal the ledger row count");
  if (!uniqueKeys) reasons.push("duplicate step keys in the ledger");
  if (delta.totalTokens !== 0 || Math.abs(delta.usd) > 1e-9) {
    reasons.push("charged totals differ from provider-reported totals on attested rows");
  }
  if (ledger.estimatedCalls > 0) {
    reasons.push(
      `${ledger.estimatedCalls} of ${rows.length} row(s) are tokeniser estimates with no provider number to check against`,
    );
  }
  if (!reasons.length) {
    reasons.push("every charged row mirrors provider-reported usage and the counters match the rows");
  }

  return {
    ledger,
    providerReported,
    tokeniserAll,
    delta,
    reportedUsd,
    estimatedUsd,
    reconciles:
      countersMatchLedger && rowsMatchSteps && uniqueKeys && delta.totalTokens === 0 && Math.abs(delta.usd) < 1e-9,
    countersMatchLedger,
    reasons,
  };
}

export function runState(runId: string): RunState | null {
  const run = getRun(runId);
  if (!run) return null;
  const rows = getLedger(runId);
  const envelope = snapshotEnvelope(run, Date.now());
  const pct = (used: number, cap: number) => (cap > 0 ? Math.min(999, (used / cap) * 100) : 0);

  return {
    run,
    ledger: rows,
    approvals: listApprovals(runId),
    negotiations: listNegotiations(runId),
    findings: listFindings(runId),
    gauges: {
      tokens: { used: run.usedTokens, cap: run.capTokens, pct: pct(run.usedTokens, run.capTokens) },
      usd: { used: run.usedUsd, cap: run.capUsd, pct: pct(run.usedUsd, run.capUsd) },
      seconds: {
        used: Math.max(0, Math.min(envelope.elapsedSeconds, run.capSeconds)),
        cap: run.capSeconds,
        pct: envelope.pctSeconds,
      },
    },
    totals: {
      tokens: rows.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0),
      usd: round10(rows.reduce((sum, r) => sum + r.usd, 0)),
      rows: rows.length,
      estimatedRows: rows.filter((r) => r.estimated).length,
    },
    reconciliation: reconcile(run, rows),
  };
}

export function inbox() {
  return {
    pending: listRuns()
      .flatMap((run) => listApprovals(run.runId))
      .filter((a) => a.status === "pending"),
    history: listRuns(25).flatMap((run) => listApprovals(run.runId)).filter((a) => a.status !== "pending"),
  };
}

export function approvalDetail(id: number) {
  const approval = getApprovalById(id);
  if (!approval) return null;
  return { approval, state: runState(approval.runId) };
}
