import { createAgent, createTool, openai, type Message } from "@inngest/agent-kit";
import { z } from "zod";
import type { Prices } from "../../../shared/types";
import { upsertFinding } from "../db";
import { estimateRequestTokens, providerRequestExtras, tokenize } from "../usage";
import type { GateOutcome } from "./budget";

/**
 * Section 6 of the spec, reproduced verbatim. The prompt asks for JSON; the
 * envelope does not depend on it complying, because enforcement happens in
 * `makeBudgetGate` before any request is sent.
 */
export const PLANNER_SYSTEM_PROMPT = `You are an agent operating inside a hard budget. Reply ONLY with JSON:
{"plan":[{"step":1,"action":"...","estimatedTokens":<int>}],
 "estimatedTotalTokens":<int>,
 "stopReason":null}
If the remaining budget cannot cover the plan, reply with
{"plan":[],"estimatedTotalTokens":0,"stopReason":"needs_more_budget","justification":"<=200 chars"}
Do not pad the plan. Do not repeat steps.`;

/**
 * Output is hard-capped so the cost of a call is bounded before it is made:
 * the gate charges the prompt estimate plus this ceiling.
 */
export const MAX_OUTPUT_TOKENS = 700;

export const EXECUTOR_SYSTEM_PROMPT = `You execute ONE step of a plan inside a hard budget. Be brief.
Reply ONLY with JSON:
{"summary":"<=160 chars","finding":"<=220 chars","needMoreBudget":false}
Use the tools when they genuinely help. Do not plan further work.`;

export interface AgentDeps {
  runId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  prices: Prices;
  /** Expected tool calls are recorded so the ledger can show what a step did. */
  onTool?: (name: string, input: unknown) => void;
}

/** Worst-case token cost of the call about to be made. */
export function conservativeCallNeed(messages: unknown[]): number {
  return estimateRequestTokens(messages) + MAX_OUTPUT_TOKENS;
}

export interface GateBlock {
  blocked: GateOutcome | null;
}

/**
 * The hard pre-call check, wired into AgentKit's `onStart` lifecycle hook —
 * which AgentKit documents as able "to stop the agent from making the call
 * altogether". Returning `stop: true` means no request is sent and no usage is
 * ever incurred, so the cap cannot be exceeded by a model that asks for more.
 *
 * The decision it enforces is the one the orchestrator already computed inside a
 * memoized Inngest step, not a fresh database read. That is deliberate:
 * `onStart` re-runs whenever Inngest replays the function (after a retry, or when
 * resuming from an approval wait), and a hook that consults the live envelope
 * during a replay can block a call that originally went through — changing the
 * branch the replay takes and corrupting the run's recorded outcome. The
 * envelope is still read from SQLite on every step; it is read once, inside a
 * step, and that read is what is enforced here.
 */
export function makeBudgetGate(gate: GateOutcome, block: GateBlock) {
  return async (args: { prompt: Message[]; history?: Message[] }) => {
    const { prompt, history } = args;
    const messages = [...prompt, ...(history ?? [])];
    if (!gate.allowed || conservativeCallNeed(messages) > gate.remaining) {
      block.blocked = { ...gate, allowed: false, at: gate.at ?? gate.binding };
      return { prompt, history: history ?? [], stop: true };
    }
    block.blocked = null;
    return { prompt, history: history ?? [], stop: false };
  };
}

const countTokensTool = (deps: AgentDeps) =>
  createTool({
    name: "count_tokens",
    description: "Count tokens in a string with the same tokeniser the ledger uses.",
    parameters: z.object({ text: z.string().describe("Text to measure") }),
    handler: async ({ text }) => {
      deps.onTool?.("count_tokens", { text });
      return { tokens: tokenize(text), estimated: false };
    },
  });

const storeFindingTool = (deps: AgentDeps) =>
  createTool({
    name: "store_finding",
    description: "Persist one finding for the current step so it survives a later refusal.",
    parameters: z
      .object({
        key: z.string().describe("Short unique key, e.g. step-2"),
        value: z.string().describe("The finding itself"),
      })
      .strict(),
    handler: async ({ key, value }) => {
      deps.onTool?.("store_finding", { key, value });
      upsertFinding({
        runId: deps.runId,
        step: Number(key.replace(/\D/g, "") || 0),
        key: key.slice(0, 64),
        value: value.slice(0, 2000),
        createdAt: new Date().toISOString(),
      });
      return { stored: true, key };
    },
  });

function adapter(deps: AgentDeps) {
  const defaultParameters = {
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    stream: false,
    ...providerRequestExtras(),
  } as NonNullable<Parameters<typeof openai>[0]["defaultParameters"]>;

  return openai({
    model: deps.model,
    baseUrl: deps.baseUrl,
    apiKey: deps.apiKey,
    defaultParameters,
  });
}

export interface BuiltAgent {
  agent: ReturnType<typeof createAgent>;
  block: GateBlock;
}

export function createPlannerAgent(deps: AgentDeps, gate: GateOutcome, label = "Planner"): BuiltAgent {
  const block: GateBlock = { blocked: null };
  const agent = createAgent({
    // AgentKit uses the agent name as the Inngest step ID, so every call needs
    // its own label or the runtime has to disambiguate duplicate step IDs.
    name: label,
    description: "Plans the work that fits inside the remaining envelope.",
    system: PLANNER_SYSTEM_PROMPT,
    model: adapter(deps),
    // One inference per run() call: the orchestrator gates between every call.
    lifecycle: { onStart: makeBudgetGate(gate, block) },
  });
  return { agent, block };
}

export function createExecutorAgent(deps: AgentDeps, gate: GateOutcome, label = "Executor"): BuiltAgent {
  const block: GateBlock = { blocked: null };
  const agent = createAgent({
    name: label,
    description: "Performs exactly one planned step, using tools if needed.",
    system: EXECUTOR_SYSTEM_PROMPT,
    model: adapter(deps),
    tools: [countTokensTool(deps), storeFindingTool(deps)],
    lifecycle: { onStart: makeBudgetGate(gate, block) },
  });
  return { agent, block };
}

/**
 * Tolerant JSON extraction: small/local models wrap objects in prose or fences.
 * Returns null rather than guessing, so the caller can log a malformed step
 * instead of inventing structure.
 */
export function extractJson(text: string): any | null {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through to brace scan */
  }
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export interface PlanStep {
  step: number;
  action: string;
  estimatedTokens: number;
}

export type PlannedStepShape = PlanStep;

export interface ParsedPlan {
  steps: PlanStep[];
  estimatedTotalTokens: number;
  stopReason: string | null;
  justification: string | null;
  raw: string;
  malformed: boolean;
}

export function parsePlan(text: string): ParsedPlan {
  const json = extractJson(text);
  const empty: ParsedPlan = {
    steps: [],
    estimatedTotalTokens: 0,
    stopReason: null,
    justification: null,
    raw: text,
    malformed: true,
  };
  if (!json || typeof json !== "object") return empty;

  const stepsRaw = Array.isArray(json.plan) ? json.plan : [];
  const steps: PlanStep[] = stepsRaw
    .map((s: any, i: number) => ({
      step: Number.isFinite(s?.step) ? Number(s.step) : i + 1,
      action: typeof s?.action === "string" ? s.action.slice(0, 300) : "",
      estimatedTokens: Number.isFinite(s?.estimatedTokens)
        ? Math.max(0, Math.round(Number(s.estimatedTokens)))
        : 0,
    }))
    .filter((s: PlanStep) => s.action.length > 0);

  return {
    steps,
    estimatedTotalTokens: Number.isFinite(json.estimatedTotalTokens)
      ? Math.round(Number(json.estimatedTotalTokens))
      : steps.reduce((sum, s) => sum + s.estimatedTokens, 0),
    stopReason: typeof json.stopReason === "string" ? json.stopReason : null,
    justification: typeof json.justification === "string" ? json.justification.slice(0, 200) : null,
    raw: text,
    malformed: steps.length === 0 && json.stopReason == null,
  };
}
