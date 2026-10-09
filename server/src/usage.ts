import { encode } from "gpt-tokenizer";
import type { Prices } from "../../shared/types";

/**
 * Framing overhead per message and per reply, matching the documented
 * `cl100k` chat-completion heuristic (3 tokens to open a message, 3 to prime a
 * reply). Estimates are always labelled as estimates; they are never silently
 * substituted for reported usage.
 */
const TOKENS_PER_MESSAGE = 3;
const REPLY_PRIMING_TOKENS = 3;

export interface ProviderUsage {
  input: number;
  output: number;
}

/** Everything the accounting layer needs to know about one model call. */
export interface ResolvedUsage extends ProviderUsage {
  estimated: boolean;
  reportedInput: number | null;
  reportedOutput: number | null;
  estInput: number;
  estOutput: number;
  rawPresent: boolean;
  usagePresent: boolean;
}

export function tokenize(text: string): number {
  if (!text) return 0;
  try {
    return encode(text, { allowedSpecial: "all" }).length;
  } catch {
    // A provider may emit control-token-looking text; fall back to a
    // whitespace-split count so accounting never throws mid-run.
    return text.split(/\s+/).filter(Boolean).length;
  }
}

export interface ChatMessageLike {
  role?: string;
  content?: unknown;
  text?: string;
}

function messageText(message: ChatMessageLike | any): string {
  if (typeof message === "string") return message;
  const content = message?.content ?? message?.text ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("");
  }
  return JSON.stringify(content ?? "");
}

/** Tokeniser estimate for a full chat request, including per-message framing. */
export function estimateRequestTokens(messages: unknown[]): number {
  let total = 0;
  for (const message of messages ?? []) {
    const raw = messageText(message as ChatMessageLike);
    const role = typeof (message as any)?.role === "string" ? (message as any).role : "";
    total += TOKENS_PER_MESSAGE + tokenize(role) + tokenize(raw);
  }
  return total + REPLY_PRIMING_TOKENS;
}

export function estimateCompletionTokens(text: string): number {
  return tokenize(text);
}

export function costUsd(inputTokens: number, outputTokens: number, prices: Prices): number {
  return (inputTokens / 1000) * prices.per1kInput + (outputTokens / 1000) * prices.per1kOutput;
}

/**
 * Read `usage.prompt_tokens` / `usage.completion_tokens` when the provider
 * returns them. Returns null when absent so the caller can fall back to an
 * estimate and label the row accordingly.
 */
export function parseProviderUsage(raw: unknown): ProviderUsage | null {
  const usage = (raw as any)?.usage;
  if (!usage || typeof usage !== "object") return null;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { input, output };
}

/**
 * The single place reported usage and estimates are reconciled for one call.
 * Charges the reported numbers when present; otherwise charges the estimate and
 * flags it. Both are always computed so the reconciliation table can show the
 * gap between them.
 */
export function resolveUsage(args: {
  raw: unknown;
  requestMessages: unknown[];
  completionText: string;
}): ResolvedUsage {
  const estInput = estimateRequestTokens(args.requestMessages);
  const estOutput = estimateCompletionTokens(args.completionText);
  const reported = parseProviderUsage(args.raw);
  const rawPresent = args.raw !== null && args.raw !== undefined;
  return {
    input: reported ? reported.input : estInput,
    output: reported ? reported.output : estOutput,
    estimated: reported === null,
    reportedInput: reported?.input ?? null,
    reportedOutput: reported?.output ?? null,
    estInput,
    estOutput,
    rawPresent,
    usagePresent: reported !== null,
  };
}

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: { role: string; content: string }[];
  maxTokens?: number;
  temperature?: number;
  /** Requested JSON mode; providers that reject it fall back automatically. */
  jsonMode?: boolean;
  timeoutMs?: number;
  /** Set false to skip the REASONING_EFFORT / STOP_TOKENS passthroughs. */
  applyProviderExtras?: boolean;
}

/**
 * Optional request-body fields for OpenAI-compatible servers whose behaviour
 * needs taming (see README: local models here otherwise spend the whole output
 * budget on hidden reasoning and leak chat-template tokens). Unset by default,
 * so the documented provider path sends ordinary requests. Both the agent
 * adapter and the direct fetch path apply the same fields, so "Test connection"
 * probes the request the agent would actually make.
 */
export function providerRequestExtras(): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (process.env.REASONING_EFFORT) extra.reasoning_effort = process.env.REASONING_EFFORT;
  if (process.env.STOP_TOKENS) {
    extra.stop = process.env.STOP_TOKENS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return extra;
}

export interface ChatResult {
  ok: boolean;
  status: number;
  bodyText: string;
  json: any | null;
  latencyMs: number;
  droppedJsonMode: boolean;
  error?: string;
}

function endpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

/**
 * Plain, non-streaming fetch to `{baseUrl}/chat/completions`. Used for
 * connectivity tests and for any direct call outside the durable agent loop.
 * LM Studio and several small local servers reject `response_format`, so the
 * request is retried once without it and the fallback is reported.
 */
export async function chatCompletion(request: ChatRequest): Promise<ChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 60_000);
  const started = Date.now();
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: false,
    ...(request.applyProviderExtras === false ? {} : providerRequestExtras()),
  };
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.jsonMode) body.response_format = { type: "json_object" };

  const send = async (payload: Record<string, unknown>) => {
    const res = await fetch(endpoint(request.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${request.apiKey || "local"}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(bodyText);
    } catch {
      /* keep raw body for display */
    }
    return { res, bodyText, json };
  };

  try {
    const first = await send(body);
    const rejectedJson =
      request.jsonMode &&
      !first.res.ok &&
      /response_format/i.test(first.bodyText) &&
      first.res.status < 500;
    if (rejectedJson) {
      const retryBody = { ...body };
      delete retryBody.response_format;
      const second = await send(retryBody);
      return {
        ok: second.res.ok,
        status: second.res.status,
        bodyText: second.bodyText,
        json: second.json,
        latencyMs: Date.now() - started,
        droppedJsonMode: true,
      };
    }
    return {
      ok: first.res.ok,
      status: first.res.status,
      bodyText: first.bodyText,
      json: first.json,
      latencyMs: Date.now() - started,
      droppedJsonMode: false,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      bodyText: "",
      json: null,
      latencyMs: Date.now() - started,
      droppedJsonMode: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface ConnectionTest extends ChatResult {
  modelsUrl: string;
  modelsStatus: number | null;
  modelCount: number | null;
  sampleModelIds: string[];
}

/**
 * "Test connection" reports what actually happened: the model list from the
 * provider plus a one-token completion, with real status codes and bodies.
 */
export async function testConnection(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<ConnectionTest> {
  const modelsUrl = `${opts.baseUrl.replace(/\/+$/, "")}/models`;
  let modelsStatus: number | null = null;
  let modelCount: number | null = null;
  let sampleModelIds: string[] = [];
  try {
    const res = await fetch(modelsUrl, {
      headers: { authorization: `Bearer ${opts.apiKey || "local"}` },
      signal: AbortSignal.timeout(10_000),
    });
    modelsStatus = res.status;
    if (res.ok) {
      const json = (await res.json()) as any;
      const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
      modelCount = list.length;
      sampleModelIds = list.slice(0, 8).map((m: any) => String(m?.id ?? m?.name ?? m));
    }
  } catch {
    /* reported as null below */
  }

  const completion = await chatCompletion({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
    maxTokens: 320,
    temperature: 0,
    timeoutMs: 60_000,
  });

  return { ...completion, modelsUrl, modelsStatus, modelCount, sampleModelIds };
}

/** Extracts the assistant text from a raw OpenAI-shaped response. */
export function textFromRaw(raw: any): string {
  const choice = raw?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join("");
  return "";
}
