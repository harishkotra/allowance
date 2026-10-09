import type { Prices, Resource, RunRow } from "../../../shared/types";
import { costUsd } from "../usage";

/** Fallback conversion rate for a degenerate envelope with no time cap. */
export const DEFAULT_TOKENS_PER_SECOND = 50;

/**
 * Converts the time that remains into the amount of work it can pay for.
 *
 * The rate is derived from the envelope itself (`capTokens / capSeconds`), so
 * the envelope is internally consistent: the token cap is exactly what fits in
 * the time cap, and time binds proportionally as the clock runs down. An
 * observed-throughput rate was tried and is wrong — one slow first call makes
 * the implied rate tiny and refuses everything that follows, dooming a run that
 * still had most of its tokens and money left.
 *
 * Set TOKENS_PER_SECOND to pin an absolute provider rate instead.
 */
export function tokensPerSecondOf(run: RunRow): number {
  const override = Number(process.env.TOKENS_PER_SECOND);
  if (Number.isFinite(override) && override > 0) return override;
  if (run.capSeconds > 0) return run.capTokens / run.capSeconds;
  return DEFAULT_TOKENS_PER_SECOND;
}

/**
 * A re-plan is only attempted when at least this many tokens are left, i.e.
 * there is room for one more real inference. Below it the run must stop.
 */
export const MIN_CALL_TOKENS = 250;

/** Envelope pressure at which the agent files its first budget request (spec section 1). */
export const BUDGET_NOTIFY_PCT = 60;

export interface EnvelopeSnapshot {
  capTokens: number;
  capUsd: number;
  capSeconds: number;
  usedTokens: number;
  usedUsd: number;
  elapsedSeconds: number;
  remainingTokens: number;
  remainingUsd: number;
  remainingSeconds: number;
  /** Token-equivalent headroom: min of the three resources (spec formula). */
  remainingTokenEquivalent: number;
  pctTokens: number;
  pctUsd: number;
  pctSeconds: number;
  /** Envelope pressure used for the ledger's cumulativePct column. */
  cumulativePct: number;
  /** The resource that currently binds hardest (or is already exhausted). */
  binding: Resource;
  deadlineBreached: boolean;
  /** Tokens per second used to convert the remaining time into headroom. */
  rateTokensPerSecond: number;
  /** Actual throughput, shown for context; never used for enforcement. */
  observedTokensPerSecond: number;
}

export function usdToTokens(usd: number, prices: Prices): number {
  // Priced at the dearer of input/output so time-and-money headroom is never
  // more generous than the cheapest possible call.
  const perToken = Math.max(prices.per1kInput, prices.per1kOutput) / 1000;
  return perToken > 0 ? Math.floor(usd / perToken) : 0;
}

export function timeRemainingToTokens(secondsRemaining: number, tokensPerSecond: number): number {
  return Math.floor(Math.max(0, secondsRemaining) * tokensPerSecond);
}

export function costUsdOf(inputTokens: number, outputTokens: number, prices: Prices): number {
  return round(costUsd(inputTokens, outputTokens, prices), 8);
}

export function pricesOf(run: RunRow): Prices {
  return { per1kInput: run.per1kInput, per1kOutput: run.per1kOutput };
}

/**
 * Reads the envelope straight from the stored run row. Called inside an Inngest
 * step so the result is memoized for replay, but never cached across runs: the
 * database is the only place remaining budget lives.
 */
export function snapshotEnvelope(run: RunRow, now: number): EnvelopeSnapshot {
  const prices = pricesOf(run);
  // A finished run's clock stops with it; otherwise the seconds gauge would keep
  // climbing past 100% long after the last step.
  const reference = run.finishedAt ? Math.min(now, Date.parse(run.finishedAt)) : now;
  const elapsedSeconds = (reference - Date.parse(run.startedAt)) / 1000;
  const remainingUsd = run.capUsd - run.usedUsd;
  // The stored deadline is the authoritative wall clock: an approved grant
  // extends it, so it cannot be re-derived from startedAt + capSeconds.
  const remainingSeconds = (Date.parse(run.deadlineAt) - reference) / 1000;
  const remainingTokenBudget = run.capTokens - run.usedTokens;

  const rate = tokensPerSecondOf(run);
  const fromTime = timeRemainingToTokens(remainingSeconds, rate);
  // Reported for display only; the gate never converts time with it.
  const observedTokensPerSecond =
    elapsedSeconds >= 1 && run.usedTokens > 0 ? run.usedTokens / elapsedSeconds : rate;
  const fromUsd = usdToTokens(remainingUsd, prices);

  const candidates: [Resource, number][] = [
    ["tokens", remainingTokenBudget],
    ["usd", fromUsd],
    ["time", fromTime],
  ];
  candidates.sort((a, b) => a[1] - b[1]);
  const binding = candidates[0][0];
  // Negative headroom is meaningful: it says how far past the binding cap.
  const remainingTokenEquivalent = candidates[0][1];

  const pct = (used: number, cap: number) => (cap > 0 ? (used / cap) * 100 : 100);
  const pctTokens = pct(run.usedTokens, run.capTokens);
  const pctUsd = pct(run.usedUsd, run.capUsd);
  const pctSeconds = pct(Math.min(elapsedSeconds, run.capSeconds), run.capSeconds);

  return {
    capTokens: run.capTokens,
    capUsd: run.capUsd,
    capSeconds: run.capSeconds,
    usedTokens: run.usedTokens,
    usedUsd: run.usedUsd,
    elapsedSeconds,
    remainingTokens: remainingTokenBudget,
    remainingUsd,
    remainingSeconds,
    remainingTokenEquivalent,
    pctTokens,
    pctUsd,
    pctSeconds,
    cumulativePct: Math.max(pctTokens, pctUsd, pctSeconds),
    binding,
    deadlineBreached: remainingSeconds <= 0,
    rateTokensPerSecond: round(rate, 4),
    observedTokensPerSecond: round(observedTokensPerSecond, 4),
  };
}

export type GateReason = "ok" | "envelope_exhausted" | "deadline";

export interface GateDecision {
  /** False means the step does not execute. */
  allowed: boolean;
  reason: GateReason;
  needTokens: number;
  needUsd: number;
  /** Token-equivalent headroom at the time of the check. */
  remainingTokenEquivalent: number;
  /** Which resource to name in the refusal. */
  at: Resource | null;
  /** A cheaper plan could still run inside what is left. */
  canReplan: boolean;
  envelope: EnvelopeSnapshot;
  checkedAt: string;
}

/**
 * The pre-call check from spec section 6. `needTokens` is the estimated cost of
 * the step about to run; the step is refused outright when it exceeds the
 * envelope, and the wall-clock deadline is enforced first because it can expire
 * mid-plan with tokens still left.
 */
export function gateFor(run: RunRow, now: number, needTokens: number): GateDecision {
  const envelope = snapshotEnvelope(run, now);
  const checkedAt = new Date(now).toISOString();

  if (envelope.deadlineBreached) {
    return {
      allowed: false,
      reason: "deadline",
      needTokens,
      needUsd: costUsd(needTokens, 0, pricesOf(run)),
      remainingTokenEquivalent: envelope.remainingTokenEquivalent,
      at: "time",
      canReplan: false,
      envelope,
      checkedAt,
    };
  }

  const allowed = needTokens <= envelope.remainingTokenEquivalent;
  if (allowed) {
    return {
      allowed: true,
      reason: "ok",
      needTokens,
      needUsd: costUsd(needTokens, 0, pricesOf(run)),
      remainingTokenEquivalent: envelope.remainingTokenEquivalent,
      at: null,
      canReplan: false,
      envelope,
      checkedAt,
    };
  }

  const cheaperPlanFits = envelope.remainingTokenEquivalent >= MIN_CALL_TOKENS;
  return {
    allowed: false,
    reason: "envelope_exhausted",
    needTokens,
    needUsd: costUsd(needTokens, 0, pricesOf(run)),
    remainingTokenEquivalent: envelope.remainingTokenEquivalent,
    at: envelope.binding,
    canReplan: cheaperPlanFits,
    envelope,
    checkedAt,
  };
}

/**
 * Flattened gate result. Steps return this rather than the nested decision so
 * what crosses an Inngest step boundary is plain JSON and survives replay
 * identically.
 */
export interface GateOutcome {
  allowed: boolean;
  reason: GateReason;
  at: Resource | null;
  needTokens: number;
  remaining: number;
  binding: Resource;
  cumulativePct: number;
  usedTokens: number;
  capTokens: number;
  usedUsd: number;
  capUsd: number;
  remainingSeconds: number;
  elapsedSeconds: number;
  canReplan: boolean;
  checkedAt: string;
}

export function gateOutcome(decision: GateDecision): GateOutcome {
  const e = decision.envelope;
  return {
    allowed: decision.allowed,
    reason: decision.reason,
    at: decision.at,
    needTokens: decision.needTokens,
    remaining: decision.remainingTokenEquivalent ?? e.remainingTokenEquivalent,
    binding: e.binding,
    cumulativePct: round(e.cumulativePct, 4),
    usedTokens: e.usedTokens,
    capTokens: e.capTokens,
    usedUsd: round(e.usedUsd, 8),
    capUsd: e.capUsd,
    remainingSeconds: round(e.remainingSeconds, 3),
    elapsedSeconds: round(e.elapsedSeconds, 3),
    canReplan: decision.canReplan,
    checkedAt: decision.checkedAt,
  };
}

export function round(value: number, places = 8): number {
  const f = 10 ** places;
  return Math.round((value + Number.EPSILON) * f) / f;
}
