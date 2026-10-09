/**
 * Wire types shared by the server and the browser client. No runtime imports
 * here — both sides compile this file directly.
 */

export type RunStatus =
  | "idle"
  | "running"
  | "awaiting-approval"
  | "refused"
  | "completed"
  | "partial-result";

/** The resource that ran out when a run is refused. */
export type Resource = "tokens" | "usd" | "time";

export interface Caps {
  capTokens: number;
  capUsd: number;
  capSeconds: number;
}

export interface Prices {
  per1kInput: number;
  per1kOutput: number;
}

export interface RunRow extends Caps, Prices {
  runId: string;
  task: string;
  status: RunStatus;
  model: string;
  baseUrl: string;
  usedTokens: number;
  usedUsd: number;
  autoApproveUnderUsd: number;
  negotiate: boolean;
  startedAt: string;
  deadlineAt: string;
  finishedAt: string | null;
  inngestRunId: string | null;
  /** Why a plan stopped without breaching the envelope, if it did. */
  stopReason: string | null;
  refuseReason: string | null;
  /** Which resource triggered a refusal: tokens | usd | time. */
  refuseAt: Resource | null;
  /** Wall-clock deadline breach, recorded separately from token maths. */
  deadlineBreached: boolean;
  planJson: string | null;
  resultJson: string | null;
  costReportJson: string | null;
  executedSteps: number;
  error: string | null;
}

export interface LedgerRow {
  id: number;
  runId: string;
  stepKey: string;
  /** 1-based sequence within the run. */
  step: number;
  phase: "plan" | "execute" | "replan" | "wind-down";
  action: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** Envelope pressure at the moment the row was written (0-100+). */
  cumulativePct: number;
  /** True when the provider returned no usage and the ledger charged an estimate. */
  estimated: boolean;
  reportedInput: number | null;
  reportedOutput: number | null;
  estInput: number;
  estOutput: number;
  toolNames: string | null;
  createdAt: string;
}

export type ApprovalTier = "auto" | "human";
export type ApprovalStatus = "pending" | "approved" | "denied" | "timeout" | "auto-approved";

export interface ApprovalRow {
  id: number;
  runId: string;
  step: number;
  requestedAt: string;
  justification: string;
  wantTokens: number;
  wantUsd: number;
  wantSeconds: number;
  estCostUsd: number;
  tier: ApprovalTier;
  status: ApprovalStatus;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
  newCapTokens: number | null;
  newCapUsd: number | null;
  newCapSeconds: number | null;
}

export interface NegotiationRow {
  id: number;
  runId: string;
  seq: number;
  kind:
    | "agent-request"
    | "human-decision"
    | "auto-decision"
    | "agent-next-action"
    | "replan"
    | "refusal"
    | "notice";
  actor: "agent" | "human" | "system";
  payload: string;
  createdAt: string;
}

export interface FindingRow {
  id: number;
  runId: string;
  step: number;
  key: string;
  value: string;
  createdAt: string;
}

/** A single side of the reconciliation table. */
export interface ReconSide {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usd: number;
  calls: number;
}

export interface Reconciliation {
  /** What the ledger charged for every step (reported where available, else estimated). */
  ledger: ReconSide & { estimatedCalls: number; reportedCalls: number };
  /** Reported-only sums, re-derived from the raw provider payloads. */
  providerReported: ReconSide;
  /** Tokeniser estimates for every call, including ones charged on reported usage. */
  tokeniserAll: ReconSide;
  /** Ledger minus provider-reported, over the calls the provider reported for. */
  delta: { inputTokens: number; outputTokens: number; totalTokens: number; usd: number };
  reportedUsd: number;
  estimatedUsd: number;
  reconciles: boolean;
  reasons: string[];
  countersMatchLedger: boolean;
}

export interface RunState {
  run: RunRow;
  ledger: LedgerRow[];
  approvals: ApprovalRow[];
  negotiations: NegotiationRow[];
  findings: FindingRow[];
  gauges: {
    tokens: { used: number; cap: number; pct: number };
    usd: { used: number; cap: number; pct: number };
    seconds: { used: number; cap: number; pct: number };
  };
  totals: { tokens: number; usd: number; rows: number; estimatedRows: number };
  reconciliation: Reconciliation;
}

/** Settings as stored in localStorage `allowance.settings.v1` (never contains the key). */
export interface ClientSettings extends Caps, Prices {
  baseUrl: string;
  model: string;
  autoApproveUnderUsd: number;
  negotiate: boolean;
  preset: string;
}
