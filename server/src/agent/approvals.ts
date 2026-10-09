import type { ApprovalTier, Prices, RunRow } from "../../../shared/types";
import { getApprovalAtStep, getDb, insertApproval, listApprovals } from "../db";
import { BUDGET_NOTIFY_PCT, MIN_CALL_TOKENS, round, type EnvelopeSnapshot } from "./budget";
import { costUsd } from "../usage";

/**
 * Approval tiers.
 *
 * - `auto`: the extra budget requested is worth no more than APPROVE_UNDER_USD,
 *   so it is granted without a human. The grant is still recorded, and still
 *   applied by the durable run rather than by the model.
 * - `human`: everything else waits for a decision in the approval inbox, with
 *   the run paused.
 */
export function tierFor(estCostUsd: number, autoApproveUnderUsd: number): ApprovalTier {
  return estCostUsd <= autoApproveUnderUsd ? "auto" : "human";
}

export interface BudgetRequestDraft {
  step: number;
  justification: string;
  wantTokens: number;
  wantUsd: number;
  wantSeconds: number;
  estCostUsd: number;
  /** An explicit agent ask always goes to a human, whatever its price. */
  tierHint?: ApprovalTier;
}

export interface PlannedStep {
  step: number;
  action: string;
  estimatedTokens: number;
}

/** Roughly how long one planned step takes, used to convert a request into seconds. */
export const SECONDS_PER_PLANNED_STEP = 20;

/** When the agent asks without a plan, it asks for a quarter of the original cap. */
export const EXPLICIT_ASK_CAP_FRACTION = 0.25;
export const EXPLICIT_ASK_SECONDS = 60;

/**
 * What the agent asks for.
 *
 * - `finish-plan`: it knows how much work is left, so it asks for the token
 *   shortfall between the remaining plan and the envelope.
 * - `explicit-ask`: the planner returned `needs_more_budget` with no plan, so
 *   there is no remaining work to price. Rather than invent one, it asks for a
 *   documented fraction of the original envelope and always goes to a human.
 */
export function requestToFinishPlan(args: {
  remainingSteps: PlannedStep[];
  envelope: EnvelopeSnapshot;
  prices: Prices;
  triggerStep: number;
  justification?: string;
  mode?: "finish-plan" | "explicit-ask";
  /** Cost of the step the gate just refused, so the ask can actually unblock it. */
  blockedNeed?: number;
}): BudgetRequestDraft {
  const mode = args.mode ?? "finish-plan";
  const want = args.remainingSteps.reduce((sum, s) => sum + s.estimatedTokens, 0);
  const headroom = args.envelope.remainingTokenEquivalent;

  const wantTokens =
    mode === "explicit-ask"
      ? Math.max(MIN_CALL_TOKENS * 2, Math.ceil(args.envelope.capTokens * EXPLICIT_ASK_CAP_FRACTION))
      : Math.max(
          1,
          Math.max(0, want - headroom),
          Math.max(0, (args.blockedNeed ?? 0) - headroom),
        );

  const estCost = round(costUsd(wantTokens / 2, wantTokens / 2, args.prices), 8);
  const justification = (args.justification ?? "").trim().slice(0, 200);
  return {
    step: args.triggerStep,
    justification:
      justification ||
      `Plan has ${args.remainingSteps.length} step(s) left needing ${wantTokens} more tokens than the envelope allows.`,
    wantTokens,
    wantUsd: estCost,
    wantSeconds:
      mode === "explicit-ask"
        ? EXPLICIT_ASK_SECONDS
        : Math.max(1, args.remainingSteps.length) * SECONDS_PER_PLANNED_STEP,
    estCostUsd: estCost,
    tierHint: mode === "explicit-ask" ? "human" : undefined,
  };
}

export type FileResult =
  | { tier: ApprovalTier; status: "auto-approved" | "pending"; created: boolean; approvalId: number }
  | { tier: ApprovalTier; status: "not-allowed"; created: false }
  | { tier: ApprovalTier; status: string; created: false };

/** Files the request. Nothing here raises a cap: only a decision does. */
export function fileBudgetRequest(args: {
  run: RunRow;
  draft: BudgetRequestDraft;
  requestedAt: string;
}): FileResult {
  const tier = args.draft.tierHint ?? tierFor(args.draft.estCostUsd, args.run.autoApproveUnderUsd);
  const existing = getApprovalAtStep(args.run.runId, args.draft.step);
  if (existing) {
    return { tier: existing.tier, status: existing.status, created: false, approvalId: existing.id };
  }

  if (!args.run.negotiate && tier === "human") {
    return { tier, status: "not-allowed", created: false };
  }

  insertApproval({
    runId: args.run.runId,
    step: args.draft.step,
    requestedAt: args.requestedAt,
    justification: args.draft.justification,
    wantTokens: args.draft.wantTokens,
    wantUsd: args.draft.wantUsd,
    wantSeconds: args.draft.wantSeconds,
    estCostUsd: args.draft.estCostUsd,
    tier,
    status: tier === "auto" ? "auto-approved" : "pending",
  });

  const row = getApprovalAtStep(args.run.runId, args.draft.step)!;
  return { tier, status: row.status as "auto-approved" | "pending", created: true, approvalId: row.id };
}

/** Caps implied by granting a request. The model can never produce these itself. */
export function capsAfterGrant(
  run: RunRow,
  approval: { wantTokens: number; wantUsd: number; wantSeconds: number },
  now: number,
): { capTokens: number; capUsd: number; capSeconds: number; deadlineAt: string } {
  const grantedDeadline = now + approval.wantSeconds * 1000;
  const current = Date.parse(run.deadlineAt);
  return {
    capTokens: run.capTokens + approval.wantTokens,
    capUsd: round(run.capUsd + approval.wantUsd, 8),
    capSeconds: round(run.capSeconds + approval.wantSeconds, 3),
    // A grant extends the wall clock; it never shortens an unused deadline.
    deadlineAt: new Date(Math.max(current, grantedDeadline)).toISOString(),
  };
}

/**
 * The 60% trigger from the spec: ask once, when envelope pressure first crosses
 * the notify threshold — but only if there is a genuine shortfall. Crossing 60%
 * while the rest of the plan still fits is worth a note in the transcript, not a
 * request; filing one then would ask for ~1 token of extra budget, which is
 * noise rather than negotiation.
 */
export function shouldRequestAtThreshold(args: {
  runId: string;
  cumulativePct: number;
  wantTokens: number;
  remainingTokenEquivalent: number;
}): boolean {
  if (args.cumulativePct < BUDGET_NOTIFY_PCT) return false;
  if (args.wantTokens <= args.remainingTokenEquivalent) return false;
  return listApprovals(args.runId).length === 0;
}

export function pendingApproval(runId: string) {
  return listApprovals(runId).find((a) => a.status === "pending");
}

export interface DecisionRow {
  alreadyDecided?: boolean;
  id: number;
  run_id: string;
  step: number;
  status: string;
}

/** Writes a human decision. Caps are applied afterwards, by the durable run. */
export function recordDecision(args: {
  runId: string;
  approvalId: number;
  decision: "approved" | "denied";
  decidedBy: string;
  note?: string | null;
}): DecisionRow | undefined {
  const existing = getDb()
    .prepare("SELECT id, run_id, step, status FROM approvals WHERE id = ? AND run_id = ?")
    .get(args.approvalId, args.runId) as DecisionRow | undefined;
  if (!existing) return undefined;
  if (existing.status !== "pending") return { ...existing, alreadyDecided: true };

  getDb()
    .prepare(
      `UPDATE approvals SET status = @status, decided_at = @decidedAt, decided_by = @decidedBy, note = @note
       WHERE id = @id AND status = 'pending'`,
    )
    .run({
      id: args.approvalId,
      status: args.decision,
      decidedBy: args.decidedBy,
      note: args.note ?? null,
      decidedAt: new Date().toISOString(),
    });
  return getDb()
    .prepare("SELECT id, run_id, step, status FROM approvals WHERE id = ?")
    .get(args.approvalId) as DecisionRow;
}
