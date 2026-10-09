import { Inngest, NonRetriableError } from "inngest";
import type { LedgerRow, Prices, Resource, RunRow } from "../../../shared/types";
import {
  applyGrant,
  appendNegotiation,
  commitLedgerAndCounters,
  getApprovalById,
  getDb,
  getLedger,
  getRun,
  listFindings,
  updateRun,
} from "../db";
import { resolveUsage, textFromRaw } from "../usage";
import {
  BUDGET_NOTIFY_PCT,
  MIN_CALL_TOKENS,
  costUsdOf,
  gateFor,
  gateOutcome,
  pricesOf,
  snapshotEnvelope,
} from "../agent/budget";
import {
  capsAfterGrant,
  fileBudgetRequest,
  requestToFinishPlan,
  shouldRequestAtThreshold,
} from "../agent/approvals";
import {
  PLANNER_SYSTEM_PROMPT,
  conservativeCallNeed,
  createExecutorAgent,
  createPlannerAgent,
  parsePlan,
  type ParsedPlan,
  type PlannedStepShape,
} from "../agent/agent";

export const inngest = new Inngest({ id: "allowance" });

/**
 * Upper bound on how long a paused run waits for a human. The real window is the
 * smaller of this and the envelope's remaining wall clock, so a tight time cap
 * cannot be stretched out by an unanswered request.
 */
export const APPROVAL_TIMEOUT_MS = 15 * 60_000;

/**
 * The event name carries the run id, so a decision can never be consumed by a
 * different run's wait.
 */
export function approvalEventName(runId: string): string {
  return `allowance/approval.resolved.run-${runId}`;
}

const plannerPrompt = (task: string, remainingTokens: number, extra = "") =>
  `${extra ? `${extra}\n` : ""}Task: ${task}\nRemaining budget: ${Math.max(0, Math.round(remainingTokens))} tokens.`;

const executorPrompt = (task: string, action: string, stepNo: number, known: string[]) =>
  `Task: ${task}\nStep ${stepNo}: ${action}\n` +
  `Findings so far: ${known.length ? known.join(" | ").slice(0, 900) : "none"}\n` +
  `Do only step ${stepNo}. Reply with the JSON shape requested.`;

const windDownPrompt = (task: string, known: string[]) =>
  `Task: ${task}\nThe budget request was refused. Summarise ONLY what is already known, as a partial result.\n` +
  `Findings so far: ${known.length ? known.join(" | ").slice(0, 900) : "none"}\n` +
  `Reply ONLY with JSON: {"partialResult":"<=400 chars","unfinished":<int>}`;

function nextSeq(runId: string): number {
  const row = getDb()
    .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM negotiations WHERE run_id = ?")
    .get(runId) as { seq: number };
  return row.seq + 1;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Turns one AgentKit AgentResult into exactly one ledger row. Reads provider
 * usage from the raw payload; when it is absent the row is charged a tokeniser
 * estimate and flagged. Both numbers are always stored so the reconciliation
 * table can show the gap between them.
 */
function account(args: {
  runId: string;
  stepKey: string;
  step: number;
  phase: LedgerRow["phase"];
  action: string | null;
  raw: unknown;
  requestMessages: unknown[];
  completionText: string;
  toolNames: string[];
}): LedgerRow | null {
  const run = getRun(args.runId);
  if (!run) return null;
  const prices = pricesOf(run);
  const usage = resolveUsage({
    raw: args.raw,
    requestMessages: args.requestMessages,
    completionText: args.completionText,
  });
  const envelope = snapshotEnvelope(run, Date.now());
  const usd = costUsdOf(usage.input, usage.output, prices);
  const cumulativePct = Math.max(
    (envelope.usedTokens + usage.input + usage.output) / (envelope.capTokens || 1) * 100,
    (envelope.usedUsd + usd) / (envelope.capUsd || 1) * 100,
    envelope.pctSeconds,
  );

  commitLedgerAndCounters({
    runId: args.runId,
    stepKey: args.stepKey,
    step: args.step,
    phase: args.phase,
    action: args.action,
    model: run.model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    usd,
    cumulativePct,
    estimated: usage.estimated,
    reportedInput: usage.reportedInput,
    reportedOutput: usage.reportedOutput,
    estInput: usage.estInput,
    estOutput: usage.estOutput,
    rawPresent: usage.rawPresent,
    toolNames: args.toolNames.length ? args.toolNames.join(",") : null,
    createdAt: new Date().toISOString(),
  });

  return getLedger(args.runId).find((row) => row.stepKey === args.stepKey) ?? null;
}

function textOfResult(result: { raw?: string; output: any[] }): { raw: unknown; text: string } {
  let parsed: unknown = null;
  if (result.raw) {
    try {
      parsed = JSON.parse(result.raw);
    } catch {
      parsed = null;
    }
  }
  const fromRaw = parsed ? textFromRaw(parsed) : "";
  const fromOutput = (result.output ?? [])
    .filter((m: any) => m?.type === "text" && m?.role === "assistant")
    .map((m: any) => (typeof m.content === "string" ? m.content : ""))
    .join("");
  return { raw: parsed, text: fromRaw || fromOutput };
}

function messagesSent(result: { prompt?: any[]; history?: any[] }): unknown[] {
  return [...(result.prompt ?? []), ...(result.history ?? [])];
}

function refusalRow(
  runId: string,
  at: Resource,
  needTokens: number,
  remaining: number,
  cause: string,
): { at: Resource } {
  const now = new Date().toISOString();
  updateRun(runId, {
    status: "refused",
    refuseReason: "envelope_exhausted",
    refuseAt: at,
    deadlineBreached: at === "time",
    finishedAt: now,
  });
  updateRun(runId, { costReportJson: JSON.stringify(costReport(runId)) });
  appendNegotiation({
    runId,
    seq: nextSeq(runId),
    kind: "refusal",
    actor: "system",
    payload: {
      reason: "envelope_exhausted",
      at,
      cause,
      neededTokens: Math.round(needTokens),
      remainingTokenEquivalent: Math.round(remaining),
      message: `REFUSED: the ${at} envelope was exhausted before the next step could execute.`,
    },
    createdAt: now,
  });
  return { at };
}

export interface CostReport {
  runId: string;
  status: RunRow["status"];
  model: string;
  tokens: { used: number; cap: number };
  usd: { used: number; cap: number };
  seconds: { elapsed: number; cap: number };
  stepsExecuted: number;
  ledgerRows: number;
  estimatedRows: number;
  reportedRows: number;
  refuseReason: string | null;
  refuseAt: Resource | null;
  stopReason: string | null;
  generatedAt: string;
}

function costReport(runId: string): CostReport {
  const run = getRun(runId)!;
  const rows = getLedger(runId);
  const envelope = snapshotEnvelope(run, Date.now());
  return {
    runId,
    status: run.status,
    model: run.model,
    tokens: { used: run.usedTokens, cap: run.capTokens },
    usd: { used: round6(run.usedUsd), cap: run.capUsd },
    seconds: { elapsed: round6(envelope.elapsedSeconds), cap: run.capSeconds },
    stepsExecuted: run.executedSteps,
    ledgerRows: rows.length,
    estimatedRows: rows.filter((r) => r.estimated).length,
    reportedRows: rows.filter((r) => !r.estimated).length,
    refuseReason: run.refuseReason,
    refuseAt: run.refuseAt,
    stopReason: run.stopReason,
    generatedAt: new Date().toISOString(),
  };
}

interface RunOutcome {
  status: RunRow["status"];
  stopReason?: string | null;
  refuseAt?: Resource | null;
  steps: number;
}

export const allowanceRun = inngest.createFunction(
  {
    id: "allowance-run",
    triggers: { event: "allowance/run.started" },
    // A dead provider should surface as an outcome, not three long retries.
    retries: 1,
    onFailure: async ({ event }) => {
      const runId = (event?.data as any)?.runId as string | undefined;
      if (!runId || !getRun(runId)) return;
      updateRun(runId, {
        status: "partial-result",
        stopReason: "run_error",
        finishedAt: new Date().toISOString(),
        error: String((event as any)?.data?.error ?? "function failed"),
        costReportJson: JSON.stringify(safeCostReport(runId)),
      });
    },
  },
  async ({ event, step, runId: inngestRunId }) => {
    const { runId } = event.data as { runId: string };
    const run0 = getRun(runId);
    if (!run0) throw new NonRetriableError(`unknown run ${runId}`);

    const task = run0.task;
    const prices: Prices = pricesOf(run0);
    const deps = {
      runId,
      model: run0.model,
      baseUrl: run0.baseUrl,
      apiKey: process.env.OPENAI_API_KEY ?? "",
      prices,
    };

    await step.run("begin", () => updateRun(runId, { status: "running", inngestRunId, error: null }));

    let outcome: RunOutcome | null = null;
    let plan: ParsedPlan | null = null;
    let lastText = "";

    // ---------------------------------------------------------------- planning
    const planNeed = conservativeCallNeed([
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "user", content: plannerPrompt(task, 0) },
    ]);
    const planGate = await step.run("gate:plan", () => gateOutcome(gateFor(getRun(runId)!, Date.now(), planNeed)));

    if (planGate.allowed) {
      const planner = createPlannerAgent(deps, planGate, "Planner:plan");
      const result = await planner.agent.run(
        plannerPrompt(task, planGate.remaining),
        { step, maxIter: 1 },
      );
      const parsed = textOfResult(result);
      lastText = parsed.text;

      if (result.output.length === 0 && planner.block.blocked) {
        // Hard gate stopped the call: no request sent, no usage, no ledger row.
        const at = (planner.block.blocked.at ?? "tokens") as Resource;
        await step.run("blocked:plan", () =>
          refusalRow(runId, at, planNeed, planner.block.blocked!.remaining, "plan-hard-gate"),
        );
        outcome = { status: "refused", refuseAt: at, steps: 0 };
      } else {
        const row = await step.run("ledger:plan", () =>
          account({
            runId,
            stepKey: "plan:0",
            step: 1,
            phase: "plan",
            action: "plan",
            raw: parsed.raw,
            requestMessages: messagesSent(result),
            completionText: parsed.text,
            toolNames: [],
          }),
        );
        plan = parsePlan(parsed.text);
        await step.run("save-plan", () => {
          updateRun(runId, {
            planJson: JSON.stringify({
              steps: plan!.steps,
              estimatedTotalTokens: plan!.estimatedTotalTokens,
              stopReason: plan!.stopReason,
              justification: plan!.justification,
              malformed: plan!.malformed,
              plannerLedger: row ? { tokens: row.inputTokens + row.outputTokens, usd: row.usd } : null,
            }),
          });
          appendNegotiation({
            runId,
            seq: nextSeq(runId),
            kind: "notice",
            actor: "agent",
            payload: {
              notice: "plan produced",
              steps: plan!.steps.length,
              estimatedTotalTokens: plan!.estimatedTotalTokens,
              stopReason: plan!.stopReason,
              malformed: plan!.malformed,
              rawText: parsed.text.slice(0, 400),
            },
            createdAt: new Date().toISOString(),
          });
        });
      }
    } else {
      const at = (planGate.at ?? "tokens") as Resource;
      await step.run("refuse:plan-gate", () =>
        refusalRow(runId, at, planNeed, planGate.remaining, "plan-gate"),
      );
      outcome = { status: "refused", refuseAt: at, steps: 0 };
    }

    // ------------------------------------ planner produced nothing usable
    if (!outcome && plan && plan.steps.length === 0 && plan.stopReason !== "needs_more_budget") {
      // A model that ignored the reply contract is not asking for money; widening
      // the envelope cannot fix it. Stop cleanly with what is already stored.
      outcome = await step.run("finish:unparseable-plan", () => {
        updateRun(runId, {
          status: "partial-result",
          stopReason: "unparseable_plan",
          finishedAt: new Date().toISOString(),
        });
        const report = costReport(runId);
        updateRun(runId, {
          costReportJson: JSON.stringify(report),
          resultJson: JSON.stringify({
            reason: "unparseable_plan",
            plannerText: (plan?.raw ?? "").slice(0, 600),
            findings: listFindings(runId),
            costReport: report,
          }),
        });
        appendNegotiation({
          runId,
          seq: nextSeq(runId),
          kind: "notice",
          actor: "system",
          payload: {
            notice:
              "planner returned no usable plan without asking for budget; stopping as a partial result rather than negotiating",
            malformed: plan?.malformed,
            rawText: (plan?.raw ?? "").slice(0, 200),
          },
          createdAt: new Date().toISOString(),
        });
        return { status: "partial-result" as const, steps: 0, stopReason: "unparseable_plan" };
      });
    }

    // ------------------------------------------------- planner asked for budget
    if (!outcome && plan && plan.stopReason === "needs_more_budget") {
      const resolved = await handleBudgetRequest(step, {
        runId,
        triggerStep: 1,
        remainingSteps: [],
        justification: plan.justification ?? "the planner could not fit a plan inside the envelope",
        needTokens: planNeed,
        reason: "planner",
        mode: "explicit-ask",
      });

      if (resolved.kind === "refused") {
        outcome = { status: "refused", refuseAt: resolved.at, steps: 0 };
      } else if (resolved.kind === "denied" || resolved.kind === "timeout") {
        outcome = await windDown(step, runId, task, resolved.kind, resolved.note);
      } else {
        const replanGate = await step.run("gate:replan-after-grant", () =>
          gateOutcome(gateFor(getRun(runId)!, Date.now(), planNeed)),
        );
        if (replanGate.allowed) {
          const planner = createPlannerAgent(deps, replanGate, "Planner:replan-after-grant");
          const result = await planner.agent.run(
            plannerPrompt(
              task,
              replanGate.remaining,
              "Budget was approved. Plan again within the new envelope.",
            ),
            { step, maxIter: 1 },
          );
          const parsed = textOfResult(result);
          lastText = parsed.text;
          if (!(result.output.length === 0 && planner.block.blocked)) {
            await step.run("ledger:replan:grant", () =>
              account({
                runId,
                stepKey: "replan:grant",
                step: 2,
                phase: "replan",
                action: "re-plan after approval",
                raw: parsed.raw,
                requestMessages: messagesSent(result),
                completionText: parsed.text,
                toolNames: [],
              }),
            );
            plan = parsePlan(parsed.text);
          }
        } else {
          outcome = { status: "partial-result", steps: 0, stopReason: "no_room_after_grant" };
        }
      }
    }

    // -------------------------------------------------------------- execution
    const stepsToRun: PlannedStepShape[] = plan?.steps ?? [];
    let executed = 0;
    let replansLeft = 2;

    for (let index = 0; index < stepsToRun.length && !outcome; index++) {
      const planned = stepsToRun[index];
      const need = Math.max(
        planned.estimatedTokens || 0,
        conservativeCallNeed([
          { role: "system", content: "executor" },
          { role: "user", content: executorPrompt(task, planned.action, planned.step, []) },
        ]),
      );

      let gate = await step.run(`gate:exec:${index}`, () => gateOutcome(gateFor(getRun(runId)!, Date.now(), need)));

      if (!gate.allowed) {
        // Spec section 6: running past the wall clock is a refusal, not something
        // to negotiate — "exceeding it produces REFUSED{at:'time'} even mid-plan".
        // Token and money pressure are what open a budget request.
        if (gate.reason === "deadline") {
          await step.run(`refuse:deadline:${index}`, () =>
            refusalRow(runId, "time", need, gate.remaining, "step-gate:deadline"),
          );
          outcome = { status: "refused", refuseAt: "time", steps: executed };
          break;
        }

        // A blocked step first tries a cheaper plan that fits what is left; only
        // when that is impossible does it ask a human for budget.
        let recovered = false;
        if (gate.canReplan && replansLeft > 0) {
          replansLeft -= 1;
          const revised = await replanWithinRemainder(step, {
            runId,
            task,
            need,
            remaining: gate.remaining,
            executed,
            tag: `block:${index}`,
            fromSteps: stepsToRun.length - index,
          });
          if (revised.ok) {
            stepsToRun.splice(index, stepsToRun.length - index, ...revised.steps);
            const again = await step.run(`gate:exec:${index}:after-replan`, () =>
              gateOutcome(gateFor(getRun(runId)!, Date.now(), need)),
            );
            if (again.allowed) {
              gate = again;
              recovered = true;
            }
          }
        }

        if (!recovered) {
          const handled = await handleBudgetRequest(step, {
            runId,
            triggerStep: planned.step,
            remainingSteps: stepsToRun.slice(index),
            justification: `Blocked before step ${planned.step} ("${planned.action.slice(0, 80)}").`,
            needTokens: need,
            reason: "gate",
            mode: "finish-plan",
          });

          if (handled.kind === "granted") {
            gate = await step.run(`gate:exec:retry:${index}`, () =>
              gateOutcome(gateFor(getRun(runId)!, Date.now(), need)),
            );
            if (!gate.allowed) {
              const at = (gate.at ?? "tokens") as Resource;
              await step.run(`refuse:after-grant:${index}`, () =>
                refusalRow(runId, at, need, gate.remaining, "step-gate:no-recovery-after-grant"),
              );
              outcome = { status: "refused", refuseAt: at, steps: executed };
              break;
            }
          } else if (handled.kind === "refused") {
            outcome = { status: "refused", refuseAt: handled.at, steps: executed };
            break;
          } else {
            outcome = await windDown(step, runId, task, handled.kind, handled.note);
            break;
          }
        }
      }

      const findings = await step.run(`findings:exec:${index}`, () =>
        listFindings(runId).map((f) => `${f.key}: ${f.value.slice(0, 120)}`),
      );

      const toolNames: string[] = [];
      const executor = createExecutorAgent(
        { ...deps, onTool: (name) => toolNames.push(name) },
        gate,
        `Executor:${index}`,
      );
      const result = await executor.agent.run(
        executorPrompt(task, planned.action, planned.step, findings),
        { step, maxIter: 1 },
      );
      const parsed = textOfResult(result);
      lastText = parsed.text;

      if (result.output.length === 0 && executor.block.blocked) {
        const at = (executor.block.blocked.at ?? "tokens") as Resource;
        await step.run(`notice:blocked:${index}`, () =>
          appendNegotiation({
            runId,
            seq: nextSeq(runId),
            kind: "notice",
            actor: "system",
            payload: {
              notice: `hard gate blocked step ${planned.step}; no request was sent`,
              at,
              neededTokens: executor.block.blocked!.needTokens,
            },
            createdAt: new Date().toISOString(),
          }),
        );
        await step.run(`refuse:blocked:${index}`, () =>
          refusalRow(runId, at, need, executor.block.blocked!.remaining, "hard-gate:blocked-executor-call"),
        );
        outcome = { status: "refused", refuseAt: at, steps: executed };
        break;
      }

      await step.run(`ledger:exec:${index}`, () =>
        account({
          runId,
          stepKey: `exec:${index}`,
          step: executed + 2,
          phase: "execute",
          action: planned.action.slice(0, 200),
          raw: parsed.raw,
          requestMessages: messagesSent(result),
          completionText: parsed.text,
          toolNames: [...toolNames],
        }),
      );
      executed += 1;

      // A provider that over-delivers beyond max_tokens is recorded, not hidden.
      const overage = await step.run(`overage:exec:${index}`, () => {
        const fresh = getRun(runId)!;
        return { pastCap: fresh.usedTokens > fresh.capTokens, used: fresh.usedTokens, cap: fresh.capTokens };
      });
      if (overage.pastCap) {
        const at = await step.run(`refuse:overage:${index}`, () =>
          refusalRow(runId, "tokens", need, 0, "provider-overshot-max-completion-tokens").at,
        );
        outcome = { status: "refused", refuseAt: at, steps: executed };
        break;
      }

      // ------------------------------------------------ 60% negotiation prompt
      const threshold = await step.run(`threshold:exec:${index}`, () => {
        const fresh = getRun(runId)!;
        const env = snapshotEnvelope(fresh, Date.now());
        const remainingSteps = stepsToRun.slice(index + 1);
        const want = remainingSteps.reduce((sum, s) => sum + s.estimatedTokens, 0);
        const crossed = env.cumulativePct >= BUDGET_NOTIFY_PCT;
        const shouldAsk = shouldRequestAtThreshold({
          runId,
          cumulativePct: env.cumulativePct,
          wantTokens: want,
          remainingTokenEquivalent: env.remainingTokenEquivalent,
        });
        if (crossed && !shouldAsk && want <= env.remainingTokenEquivalent) {
          appendNegotiation({
            runId,
            seq: nextSeq(runId),
            kind: "notice",
            actor: "agent",
            payload: {
              notice: `crossed ${BUDGET_NOTIFY_PCT}% of the envelope; the remaining ${remainingSteps.length} step(s) still fit, so no budget was requested`,
              pct: Math.round(env.cumulativePct),
              want,
              remaining: Math.round(env.remainingTokenEquivalent),
            },
            createdAt: new Date().toISOString(),
          });
        }
        return { pct: env.cumulativePct, shouldAsk, want, remaining: env.remainingTokenEquivalent };
      });

      if (threshold.shouldAsk) {
        const handled = await handleBudgetRequest(step, {
          runId,
          triggerStep: planned.step + 1,
          remainingSteps: stepsToRun.slice(index + 1),
          justification: `Crossed ${Math.round(threshold.pct)}% of the envelope with ${
            stepsToRun.length - index - 1
          } step(s) left.`,
          needTokens: need,
          reason: "threshold",
          mode: "finish-plan",
        });
        if (handled.kind === "denied" || handled.kind === "timeout") {
          outcome = await windDown(step, runId, task, handled.kind, handled.note);
          break;
        }
      }

      // -------------------------------------------- cheaper-plan re-planning
      const replanCheck = await step.run(`replan-check:${index}`, () => {
        const fresh = getRun(runId)!;
        const env = snapshotEnvelope(fresh, Date.now());
        const next = stepsToRun.slice(index + 1);
        const want = next.reduce((sum, s) => sum + s.estimatedTokens, 0);
        return {
          remaining: env.remainingTokenEquivalent,
          needsReplan: want > env.remainingTokenEquivalent && env.remainingTokenEquivalent >= MIN_CALL_TOKENS,
          stepsLeft: next.length,
        };
      });

      if (replanCheck.needsReplan && replansLeft > 0) {
        replansLeft -= 1;
        const revised = await replanWithinRemainder(step, {
          runId,
          task,
          need,
          remaining: replanCheck.remaining,
          executed,
          tag: `ahead:${index}`,
          fromSteps: replanCheck.stepsLeft,
        });
        if (revised.ok) {
          stepsToRun.splice(index + 1, stepsToRun.length - index - 1, ...revised.steps);
        } else {
          const at = (revised.at ?? "tokens") as Resource;
          await step.run(`refuse:replan:${index}`, () =>
            refusalRow(runId, at, need, revised.remaining, "proactive-replan:could-not-fit"),
          );
          outcome = { status: "refused", refuseAt: at, steps: executed };
          break;
        }
      }
    }

    // ------------------------------------------------------------- completion
    if (!outcome) {
      outcome = await step.run("finish", () => {
        updateRun(runId, {
          status: "completed",
          finishedAt: new Date().toISOString(),
          resultJson: JSON.stringify({
            plan: plan?.steps ?? [],
            findings: listFindings(runId),
            lastText: lastText.slice(0, 1200),
          }),
        });
        // Recomputed after the status lands so the report describes the finished run.
        updateRun(runId, { costReportJson: JSON.stringify(costReport(runId)) });
        appendNegotiation({
          runId,
          seq: nextSeq(runId),
          kind: "notice",
          actor: "system",
          payload: { notice: "run completed inside the envelope", executed },
          createdAt: new Date().toISOString(),
        });
        return { status: "completed" as const, steps: executed };
      });
    } else if (outcome.status !== "partial-result") {
      await step.run("finish:finalise", () =>
        updateRun(runId, { costReportJson: JSON.stringify(costReport(runId)) }),
      );
    }

    return {
      runId,
      status: outcome.status,
      executed: outcome.steps,
      stopReason: outcome.stopReason ?? null,
      refusedAt: outcome.refuseAt ?? null,
      costReport: await step.run("cost-report", () => safeCostReport(runId)),
    };
  },
);

function safeCostReport(runId: string): CostReport | null {
  try {
    return costReport(runId);
  } catch {
    return null as unknown as CostReport;
  }
}

type GrantResult = { kind: "granted"; approvalId: number };

/**
 * Files a budget request and, when it needs a human, pauses the durable run.
 * The envelope itself is only ever widened here, from inside a step, after a
 * decision exists — the model has no path to raise its own cap.
 */
async function handleBudgetRequest(
  step: any,
  args: {
    runId: string;
    triggerStep: number;
    remainingSteps: PlannedStepShape[];
    justification?: string;
    needTokens: number;
    reason: string;
    mode: "finish-plan" | "explicit-ask";
  },
): Promise<GrantResult | { kind: "refused"; at: Resource | null } | { kind: "denied" | "timeout"; note: string }> {
  // One invariant covers every caller: once the wall clock is gone there is
  // nothing to negotiate. Time is refused, tokens and dollars are asked about.
  const clock = await step.run(`gate:clock:${args.reason}:${args.triggerStep}`, () =>
    gateOutcome(gateFor(getRun(args.runId)!, Date.now(), 1)),
  );
  if (clock.reason === "deadline") {
    await step.run(`refuse:clock:${args.reason}:${args.triggerStep}`, () =>
      refusalRow(args.runId, "time", args.needTokens, clock.remaining, "budget-request:clock-already-expired"),
    );
    return { kind: "refused", at: "time" };
  }

  const filed = await step.run(`request:${args.reason}:${args.triggerStep}`, () => {
    const run = getRun(args.runId)!;
    const env = snapshotEnvelope(run, Date.now());
    const draft = requestToFinishPlan({
      remainingSteps: args.remainingSteps,
      envelope: env,
      prices: pricesOf(run),
      triggerStep: args.triggerStep,
      justification: args.justification,
      mode: args.mode,
      blockedNeed: args.reason === "gate" ? args.needTokens : 0,
    });
    const result = fileBudgetRequest({ run, draft, requestedAt: new Date().toISOString() });
    appendNegotiation({
      runId: args.runId,
      seq: nextSeq(args.runId),
      kind: "agent-request",
      actor: "agent",
      payload: { ...draft, tier: result.tier, status: result.status },
      createdAt: new Date().toISOString(),
    });
    return result;
  });

  if (filed.status === "not-allowed") {
    const at = await step.run(`refuse:no-negotiation:${args.reason}:${args.triggerStep}`, () => {
      const run = getRun(args.runId)!;
      const env = snapshotEnvelope(run, Date.now());
      return refusalRow(args.runId, env.binding, args.needTokens, env.remainingTokenEquivalent, "budget-request:negotiation-disabled").at;
    });
    return { kind: "refused", at };
  }

  if (filed.status === "auto-approved") {
    return grantFrom(step, args.runId, filed.approvalId, `auto:${args.reason}:${args.triggerStep}`, "auto-approve tier");
  }

  if (filed.status === "approved") {
    return grantFrom(step, args.runId, filed.approvalId, `already:${args.reason}:${args.triggerStep}`, "already approved");
  }

  if (filed.status === "denied" || filed.status === "timeout") {
    return { kind: filed.status, note: `approval already ${filed.status}` };
  }

  // Human tier: pause the run until a decision arrives (or the window closes).
  // The window is bounded by the envelope's own clock — a 20-second budget does
  // not get 15 minutes of waiting — and if the deadline passes while paused, the
  // run refuses with the resource named rather than hanging on a decision that
  // can no longer be honoured.
  await step.run(`awaiting:${args.reason}:${args.triggerStep}`, () =>
    updateRun(args.runId, { status: "awaiting-approval" }),
  );

  const window = await step.run(`window:${args.reason}:${args.triggerStep}`, () => {
    const run = getRun(args.runId)!;
    const env = snapshotEnvelope(run, Date.now());
    const remainingMs = Math.max(0, env.remainingSeconds * 1000);
    const cap = env.deadlineBreached ? 0 : Math.min(APPROVAL_TIMEOUT_MS, Math.max(1000, remainingMs));
    return { timeoutMs: cap, breached: env.deadlineBreached, remainingSeconds: env.remainingSeconds };
  });

  if (window.breached || window.timeoutMs <= 1000) {
    await step.run(`refuse:window:${args.reason}:${args.triggerStep}`, () =>
      refusalRow(args.runId, "time", args.needTokens, window.remainingSeconds, "budget-request:window-would-overflow-deadline"),
    );
    return { kind: "refused", at: "time" };
  }

  await step.waitForEvent(`wait:${args.reason}:${args.triggerStep}`, {
    event: approvalEventName(args.runId),
    timeout: `${Math.round(window.timeoutMs)}ms`,
  });

  const resolved = await step.run(`resolve:${args.reason}:${args.triggerStep}`, () => {
    const approval = getApprovalById(filed.approvalId);
    const env = snapshotEnvelope(getRun(args.runId)!, Date.now());
    if (!approval) return { decision: "missing" as const, status: "missing", breached: env.deadlineBreached };
    if (approval.status === "pending") {
      // Timed out: record it as a denial so the inbox shows a real outcome.
      getDb()
        .prepare(
          `UPDATE approvals SET status = 'timeout', decided_at = @decidedAt, decided_by = 'timeout',
             note = 'no decision before the approval window closed' WHERE id = @id AND status = 'pending'`,
        )
        .run({ id: approval.id, decidedAt: new Date().toISOString() });
      if (env.deadlineBreached) {
        // The window closed because the envelope's clock ran out, which is a
        // refusal with a named resource, not merely an unanswered request.
        refusalRow(args.runId, "time", args.needTokens, env.remainingTokenEquivalent, "budget-request:deadline-passed-during-wait");
        return { decision: "timeout" as const, status: "deadline", breached: true };
      }
      return { decision: "timeout" as const, status: "timeout", breached: true };
    }
    return { decision: approval.status, status: approval.status, breached: env.deadlineBreached };
  });

  if (resolved.status === "deadline") {
    return { kind: "refused", at: "time" };
  }

  if (resolved.status === "approved") {
    await step.run(`resume:${args.reason}:${args.triggerStep}`, () =>
      appendNegotiation({
        runId: args.runId,
        seq: nextSeq(args.runId),
        kind: "human-decision",
        actor: "human",
        payload: { decision: "approved", approvalId: filed.approvalId },
        createdAt: new Date().toISOString(),
      }),
    );
    return grantFrom(step, args.runId, filed.approvalId, `grant:${args.reason}:${args.triggerStep}`, "human approved");
  }

  const kind = resolved.status === "timeout" ? "timeout" : "denied";
  await step.run(`denied-note:${args.reason}:${args.triggerStep}`, () => {
    updateRun(args.runId, { status: "running", stopReason: kind });
    appendNegotiation({
      runId: args.runId,
      seq: nextSeq(args.runId),
      kind: "human-decision",
      actor: "human",
      payload: { decision: kind, approvalId: filed.approvalId },
      createdAt: new Date().toISOString(),
    });
  });
  return {
    kind: kind as "denied" | "timeout",
    note: kind === "timeout" ? "approval window closed with no decision" : "budget request denied",
  };
}

async function grantFrom(
  step: any,
  runId: string,
  approvalId: number,
  label: string,
  why: string,
): Promise<GrantResult> {
  await step.run(`grant:${label}`, () => {
    const run = getRun(runId)!;
    const approval = getApprovalById(approvalId);
    if (!approval) return;
    const caps = capsAfterGrant(run, approval, Date.now());
    applyGrant(approvalId, caps);
    updateRun(runId, { status: "running" });
    appendNegotiation({
      runId,
      seq: nextSeq(runId),
      kind: label.startsWith("auto") ? "auto-decision" : "human-decision",
      actor: label.startsWith("auto") ? "system" : "human",
      payload: { decision: "approved", why, approvalId, newCaps: caps },
      createdAt: new Date().toISOString(),
    });
  });
  return { kind: "granted", approvalId };
}

type ReplanResult =
  | { ok: true; steps: PlannedStepShape[] }
  | { ok: false; at: Resource | null; remaining: number };

/** Agent dependencies read from the stored run row; the key is never persisted. */
function baseDepsFrom(runId: string) {
  const run = getRun(runId)!;
  return {
    model: run.model,
    baseUrl: run.baseUrl,
    apiKey: process.env.OPENAI_API_KEY ?? "",
    prices: pricesOf(run),
  };
}

/**
 * Ask the planner for a shorter plan that fits what is left, charging its own
 * ledger row. Returns the revised steps, or the resource that made re-planning
 * impossible so the caller can refuse with that resource named.
 */
async function replanWithinRemainder(
  step: any,
  args: {
    runId: string;
    task: string;
    need: number;
    remaining: number;
    executed: number;
    tag: string;
    fromSteps: number;
  },
): Promise<ReplanResult> {
  const gate = await step.run(`gate:replan:${args.tag}`, () =>
    gateOutcome(gateFor(getRun(args.runId)!, Date.now(), args.need)),
  );
  if (!gate.allowed) return { ok: false, at: gate.at, remaining: gate.remaining };

  const planner = createPlannerAgent(
    { runId: args.runId, ...baseDepsFrom(args.runId) },
    gate,
    `Planner:replan:${args.tag}`,
  );
  const roomForSteps = Math.max(1, Math.floor(args.remaining / 400));
  const constraint =
    `Already completed ${args.executed} step(s). Only ${Math.round(args.remaining)} tokens remain. ` +
    `Plan at most ${roomForSteps} short step(s) that finish the task inside that budget.`;
  const result = await planner.agent.run(plannerPrompt(args.task, args.remaining, constraint), {
    step,
    maxIter: 1,
  });
  const parsed = textOfResult(result);
  if (result.output.length === 0 && planner.block.blocked) {
    return {
      ok: false,
      at: planner.block.blocked.at,
      remaining: planner.block.blocked.remaining,
    };
  }

  await step.run(`ledger:replan:${args.tag}`, () =>
    account({
      runId: args.runId,
      stepKey: `replan:${args.tag}`,
      step: args.executed + 2,
      phase: "replan",
      action: `re-plan to fit ${Math.round(args.remaining)} remaining tokens`,
      raw: parsed.raw,
      requestMessages: messagesSent(result),
      completionText: parsed.text,
      toolNames: [],
    }),
  );

  const revised = parsePlan(parsed.text);
  if (revised.steps.length === 0) return { ok: false, at: gate.binding, remaining: gate.remaining };

  await step.run(`notice:replan:${args.tag}`, () =>
    appendNegotiation({
      runId: args.runId,
      seq: nextSeq(args.runId),
      kind: "replan",
      actor: "agent",
      payload: {
        notice: "re-planned inside the remainder",
        fromSteps: args.fromSteps,
        toSteps: revised.steps.length,
        estimatedTotalTokens: revised.estimatedTotalTokens,
        remaining: Math.round(args.remaining),
      },
      createdAt: new Date().toISOString(),
    }),
  );
  return { ok: true, steps: revised.steps };
}

/**
 * A refusal has to end somewhere useful: one gated summarising call, or — if
 * even that will not fit — the stored findings plus a cost report, with no call.
 */
async function windDown(
  step: any,
  runId: string,
  task: string,
  reason: string,
  note: string,
): Promise<RunOutcome> {
  const findings = await step.run("findings:wind", () =>
    listFindings(runId).map((f) => `${f.key}: ${f.value.slice(0, 120)}`),
  );
  const need = conservativeCallNeed([
    { role: "system", content: "wind-down" },
    { role: "user", content: windDownPrompt(task, findings) },
  ]);
  const gate = await step.run("gate:wind", () => gateOutcome(gateFor(getRun(runId)!, Date.now(), need)));

  let summary: string | null = null;
  if (gate.allowed) {
    const executor = createExecutorAgent({ runId, ...baseDepsFrom(runId) }, gate, "Executor:wind");
    const result = await executor.agent.run(windDownPrompt(task, findings), { step, maxIter: 1 });
    const parsed = textOfResult(result);
    if (!(result.output.length === 0 && executor.block.blocked)) {
      await step.run("ledger:wind", () =>
        account({
          runId,
          stepKey: "wind:0",
          step: 0,
          phase: "wind-down",
          action: `clean stop after ${reason}`,
          raw: parsed.raw,
          requestMessages: messagesSent(result),
          completionText: parsed.text,
          toolNames: [],
        }),
      );
      summary = parsed.text.slice(0, 1200);
    }
  }

  return await step.run("finish:partial", () => {
    updateRun(runId, {
      status: "partial-result",
      stopReason: reason,
      finishedAt: new Date().toISOString(),
    });
    // Report generated after the status is final, so it never says "running".
    const report = costReport(runId);
    updateRun(runId, {
      resultJson: JSON.stringify({
        reason,
        note,
        summary,
        findings: listFindings(runId),
        costReport: report,
        summarisedByModel: summary !== null,
      }),
      costReportJson: JSON.stringify(report),
    });
    appendNegotiation({
      runId,
      seq: nextSeq(runId),
      kind: "agent-next-action",
      actor: "agent",
      payload: {
        notice: summary
          ? "produced a partial result inside the remaining budget"
          : "no budget left for a summary; returning stored findings and the cost report",
        reason,
      },
      createdAt: new Date().toISOString(),
    });
    return { status: "partial-result" as const, steps: report.stepsExecuted, stopReason: reason };
  });
}

export const functions = [allowanceRun];
