import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { serve } from "inngest/express";
import { inngest, functions, approvalEventName } from "./inngest/client";
import { createRun, getApprovalById, getRun, listRuns, openDb, updateRun, dbPath } from "./db";
import { approvalDetail, inbox, runState } from "./state";
import { recordDecision } from "./agent/approvals";
import { testConnection } from "./usage";
import type { ClientSettings } from "../../shared/types";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = Number(process.env.PORT ?? 3001);
const TERMINAL = new Set(["completed", "refused", "partial-result"]);

/** Server-side secret: held in memory for this process, never returned to a client. */
let apiKeyOverride: string | null = null;
function effectiveApiKey(): string {
  return apiKeyOverride ?? process.env.OPENAI_API_KEY ?? "";
}

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function settingsFrom(raw: unknown): ClientSettings {
  const s = (raw ?? {}) as Record<string, unknown>;
  const envNum = (key: string, fallback: number) => {
    const parsed = Number(process.env[key]);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    preset: typeof s.preset === "string" ? s.preset : "particle",
    baseUrl:
      typeof s.baseUrl === "string" && /^https?:\/\//.test(s.baseUrl)
        ? s.baseUrl.trim()
        : (process.env.OPENAI_BASE_URL ?? "https://api.particle.ai/v1"),
    model: typeof s.model === "string" && s.model.trim() ? s.model.trim() : (process.env.MODEL ?? "deepseek-v4.1-flash"),
    capTokens: clamp(numberOr(s.capTokens, envNum("CAP_TOKENS", 40_000)), 100, 100_000_000),
    capUsd: clamp(numberOr(s.capUsd, envNum("CAP_USD", 0.25)), 0.000001, 10_000),
    capSeconds: clamp(numberOr(s.capSeconds, envNum("CAP_SECONDS", 90)), 1, 86_400),
    autoApproveUnderUsd: clamp(
      numberOr(s.autoApproveUnderUsd, envNum("APPROVE_UNDER_USD", 0.05)),
      0,
      10_000,
    ),
    negotiate: typeof s.negotiate === "boolean" ? s.negotiate : (process.env.NEGOTIATE ?? "true") === "true",
    per1kInput: clamp(numberOr(s.per1kInput, envNum("PRICE_PER_1K_INPUT", 0.00015)), 0, 100),
    per1kOutput: clamp(numberOr(s.per1kOutput, envNum("PRICE_PER_1K_OUTPUT", 0.0006)), 0, 100),
  };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    db: dbPath(),
    inngestEventKey: process.env.INNGEST_EVENT_KEY ? "set" : "unset",
    inngestDev: process.env.INNGEST_DEV ?? "unset",
    model: process.env.MODEL ?? "deepseek-v4.1-flash",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.particle.ai/v1",
    hasApiKey: effectiveApiKey().length > 0,
    reasoningEffort: process.env.REASONING_EFFORT ?? null,
    stopTokens: process.env.STOP_TOKENS ?? null,
  });
});

/** Defaults for the Settings panel. Contains no secret. */
app.get("/api/defaults", (_req, res) => {
  res.json({
    ...settingsFrom({}),
    preset: "particle",
    presets: {
      particle: {
        label: "Particle.ai",
        baseUrl: "https://api.particle.ai/v1",
        model: process.env.MODEL ?? "deepseek-v4.1-flash",
      },
      lmstudio: { label: "LM Studio", baseUrl: "http://localhost:1234/v1", model: "" },
      ollama: { label: "Ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.2" },
      gemini: {
        label: "Gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
        model: "gemini-2.5-flash",
      },
      custom: { label: "Custom", baseUrl: "", model: "" },
    },
    addonKeys: {
      lmstudio: !!process.env.LMSTUDIO_BASE_URL,
      ollama: !!process.env.OLLAMA_BASE_URL,
      gemini: !!process.env.GEMINI_API_KEY,
    },
    keySource: apiKeyOverride ? "session" : effectiveApiKey() ? "env" : "missing",
  });
});

/**
 * Accepts a new inference key for this process. Deliberately one-way: nothing
 * in the API ever returns a key, so it cannot reach the browser.
 */
app.post("/api/settings/key", (req, res) => {
  const key = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
  if (!key) {
    apiKeyOverride = null;
    res.json({ cleared: true });
    return;
  }
  apiKeyOverride = key;
  res.json({ set: true, masked: `set (${key.slice(0, 3)}…${key.length} chars)` });
});

app.post("/api/test-connection", async (req, res) => {
  const settings = settingsFrom(req.body?.settings);
  const result = await testConnection({
    baseUrl: settings.baseUrl,
    apiKey: effectiveApiKey(),
    model: settings.model,
  });
  // The body is echoed for transparency; it never contains the request key.
  res.json({
    ok: result.ok,
    status: result.status,
    latencyMs: result.latencyMs,
    error: result.error ?? null,
    droppedJsonMode: result.droppedJsonMode,
    modelsUrl: result.modelsUrl,
    modelsStatus: result.modelsStatus,
    modelCount: result.modelCount,
    sampleModelIds: result.sampleModelIds,
    body: result.bodyText.slice(0, 1500),
    usage: result.json?.usage ?? null,
    contentPreview: String(result.json?.choices?.[0]?.message?.content ?? "").slice(0, 200),
  });
});

app.get("/api/runs", (_req, res) => {
  res.json(
    listRuns(50).map((run) => ({
      runId: run.runId,
      task: run.task.slice(0, 120),
      status: run.status,
      model: run.model,
      usedTokens: run.usedTokens,
      capTokens: run.capTokens,
      usedUsd: run.usedUsd,
      capUsd: run.capUsd,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      refuseAt: run.refuseAt,
      stopReason: run.stopReason,
    })),
  );
});

app.get("/api/runs/:id", (req, res) => {
  const state = runState(req.params.id);
  if (!state) {
    res.status(404).json({ error: "unknown run" });
    return;
  }
  res.json(state);
});

app.post("/api/runs", async (req, res) => {
  const task = typeof req.body?.task === "string" ? req.body.task.trim() : "";
  if (!task) {
    res.status(400).json({ error: "task is required" });
    return;
  }
  const settings = settingsFrom(req.body?.settings);
  const runId = randomUUID().replace(/-/g, "").slice(0, 12);
  const now = Date.now();

  createRun({
    runId,
    task: task.slice(0, 4000),
    model: settings.model,
    baseUrl: settings.baseUrl,
    capTokens: settings.capTokens,
    capUsd: settings.capUsd,
    capSeconds: settings.capSeconds,
    autoApproveUnderUsd: settings.autoApproveUnderUsd,
    negotiate: settings.negotiate,
    per1kInput: settings.per1kInput,
    per1kOutput: settings.per1kOutput,
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + settings.capSeconds * 1000).toISOString(),
  });

  try {
    await inngest.send({ name: "allowance/run.started", data: { runId } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A dispatch failure must still be a visible outcome, never a stuck run.
    updateRun(runId, {
      status: "refused",
      finishedAt: new Date().toISOString(),
      stopReason: "dispatch_failed",
      error: `dispatch failed: ${message}`,
    });
    res.status(502).json({
      error: `Could not reach the Inngest dev server. Start it with: npx inngest-cli dev -p 8288`,
      detail: message,
      runId,
    });
    return;
  }

  res.status(201).json({ runId, state: runState(runId) });
});

app.post("/api/runs/:id/cancel", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "unknown run" });
    return;
  }
  updateRun(run.runId, {
    status: "partial-result",
    stopReason: typeof req.body?.reason === "string" ? req.body.reason : "cancelled",
    finishedAt: new Date().toISOString(),
  });
  res.json({ ok: true, status: "partial-result" });
});

app.get("/api/approvals", (_req, res) => {
  res.json(inbox());
});

app.get("/api/approvals/:id", (req, res) => {
  const detail = approvalDetail(Number(req.params.id));
  if (!detail) {
    res.status(404).json({ error: "unknown approval" });
    return;
  }
  res.json(detail);
});

app.post("/api/approvals/:id", async (req, res) => {
  const id = Number(req.params.id);
  const decision = req.body?.decision === "approve" ? "approved" : req.body?.decision === "deny" ? "denied" : null;
  if (!decision) {
    res.status(400).json({ error: 'decision must be "approve" or "deny"' });
    return;
  }
  const before = getApprovalById(id);
  if (!before) {
    res.status(404).json({ error: "unknown approval" });
    return;
  }
  const run = getRun(before.runId);
  if (!run) {
    res.status(404).json({ error: "unknown run" });
    return;
  }

  const updated = recordDecision({
    runId: run.runId,
    approvalId: id,
    decision,
    decidedBy: typeof req.body?.decidedBy === "string" ? req.body.decidedBy : "operator",
    note: typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : null,
  });
  if (!updated) {
    res.status(404).json({ error: "unknown approval" });
    return;
  }
  if ((updated as { alreadyDecided?: boolean }).alreadyDecided) {
    res.status(409).json({ error: `already ${before?.status}`, approval: before });
    return;
  }

  let dispatched = true;
  let dispatchError: string | null = null;
  try {
    await inngest.send({
      name: approvalEventName(run.runId),
      data: { approvalId: id, decision },
    });
  } catch (error) {
    dispatched = false;
    dispatchError = error instanceof Error ? error.message : String(error);
  }

  res.json({ ok: dispatched, decision, approval: getApprovalById(id), dispatchError, state: runState(run.runId) });
});

/**
 * Server-sent state. Every payload is recomputed from SQLite, so the UI is a
 * view of the ledger rather than a running client-side tally.
 */
app.get("/api/runs/:id/stream", (req: Request, res: Response) => {
  const runId = String(req.params.id);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  let timer: NodeJS.Timeout | null = null;
  let done = false;

  const emit = () => {
    if (done) return;
    const state = runState(runId);
    if (!state) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: "unknown run" })}\n\n`);
      finish();
      return;
    }
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    if (TERMINAL.has(state.run.status)) {
      res.write(`event: end\ndata: ${JSON.stringify({ status: state.run.status })}\n\n`);
      finish();
    }
  };

  const finish = () => {
    done = true;
    if (timer) clearInterval(timer);
    res.end();
  };

  emit();
  timer = setInterval(emit, 600);
  const heartbeat = setInterval(() => {
    if (!done) res.write(": keep-alive\n\n");
  }, 15_000);

  req.on("close", () => {
    done = true;
    clearInterval(heartbeat);
    if (timer) clearInterval(timer);
  });
});

app.use("/api/inngest", serve({ client: inngest, functions }));

app.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
  console.error("[api] unhandled", err);
  if (!res.headersSent) res.status(500).json({ error: "internal error" });
});

openDb();

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`[api] allowance server on http://127.0.0.1:${PORT} (db: ${dbPath()})`);
  console.log(`[api] inngest endpoint http://127.0.0.1:${PORT}/api/inngest`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

export default app;
