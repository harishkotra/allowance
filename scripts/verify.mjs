#!/usr/bin/env node
/**
 * Allowance verification.
 *
 * Runs five scenarios against a live server and prints observed numbers.
 * Everything here goes through the real code path: HTTP API -> Inngest durable
 * steps -> provider inference -> SQLite ledger. No fixture injects a result.
 *
 * Usage: npm run verify   (starts the API and the Inngest dev server if they are
 * not already running; anything it starts, it stops again)
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ENV = loadEnv(resolve(ROOT, ".env"));
const PORT = Number(process.env.PORT ?? ENV.PORT ?? 3011);
const API = `http://127.0.0.1:${PORT}`;
const INNGEST_PORT = Number(process.env.INNGEST_PORT ?? ENV.INNGEST_PORT ?? 8288);
const INNGEST = `http://127.0.0.1:${INNGEST_PORT}`;

function loadEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const started = [];
function cleanup() {
  for (const child of started) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

function launch(command, args, label) {
  const child = spawn(command, args, { cwd: ROOT, stdio: "ignore", detached: false, env: process.env });
  started.push(child);
  return { pid: child.pid, label };
}

async function ensureStack() {
  const notes = [];
  if (!(await reachable(`${INNGEST}/api/health`))) {
    notes.push("Inngest dev server not running; starting it");
    launch("node_modules/.bin/inngest-cli", ["dev", "-p", String(INNGEST_PORT), "-u", `${API}/api/inngest`], "inngest");
    for (let i = 0; i < 40 && !(await reachable(`${INNGEST}/api/health`)); i++) await sleep(500);
  } else {
    notes.push(`Inngest dev server already running on :${INNGEST_PORT}`);
  }

  if (!(await reachable(`${API}/api/health`))) {
    notes.push("allowance API not running; starting it");
    launch("node_modules/.bin/tsx", ["--env-file-if-exists=.env", "server/src/api.ts"], "api");
    for (let i = 0; i < 60 && !(await reachable(`${API}/api/health`)); i++) await sleep(500);
  } else {
    notes.push(`allowance API already running on :${PORT}`);
  }

  if (!(await reachable(`${API}/api/health`))) fail("could not reach the allowance API");
  if (!(await reachable(`${INNGEST}/api/health`))) fail("could not reach the Inngest dev server");
  return notes;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, options) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok && res.status !== 201) throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return body;
}

async function startRun(task, settings) {
  const created = await api("/api/runs", { method: "POST", body: JSON.stringify({ task, settings }) });
  if (!created.runId) throw new Error(`no runId: ${JSON.stringify(created).slice(0, 200)}`);
  return created.runId;
}

const state = (runId) => api(`/api/runs/${runId}`);

async function waitFor(runId, predicate, { timeoutMs = 240_000, intervalMs = 3000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await state(runId);
    if (predicate(last)) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}; last status=${last?.run?.status} used=${last?.run?.usedTokens}`);
}

const TERMINAL = new Set(["completed", "refused", "partial-result"]);

const results = [];
function record(name, ok, observed) {
  results.push({ name, ok, observed });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`\n[${mark}] ${name}`);
  for (const [key, value] of Object.entries(observed)) console.log(`         ${key}: ${value}`);
}

function fail(message) {
  console.error(`\n[FATAL] ${message}`);
  cleanup();
  process.exit(1);
}

/** Invariant 5: one row per executed step, and the displayed total is the sum of rows. */
function checkLedgerIntegrity(name, s) {
  const rows = s.ledger;
  const sumTokens = rows.reduce((t, r) => t + r.inputTokens + r.outputTokens, 0);
  const sumUsd = rows.reduce((t, r) => t + r.usd, 0);
  const uniqueKeys = new Set(rows.map((r) => r.stepKey)).size;
  const ok =
    rows.length === s.run.executedSteps &&
    uniqueKeys === rows.length &&
    sumTokens === s.totals.tokens &&
    sumTokens === s.run.usedTokens &&
    Math.abs(sumUsd - s.run.usedUsd) < 1e-9 &&
    Math.abs(s.totals.usd - sumUsd) < 1e-9;
  record(
    `${name} · every executed step has exactly one ledger row and the total is DB-derived`,
    ok,
    {
      "ledger rows": rows.length,
      "run.executed_steps": s.run.executedSteps,
      "distinct step keys": uniqueKeys,
      "sum(input+output)": sumTokens,
      "server totals.tokens": s.totals.tokens,
      "runs.used_tokens": s.run.usedTokens,
      "sum(usd)": sumUsd.toFixed(8),
      "runs.used_usd": s.run.usedUsd.toFixed(8),
    },
  );
  return ok;
}

/** Invariant 1: nothing ever ran while already past the cap. */
function checkNoStepAfterCap(name, s) {
  let before = 0;
  let violated = null;
  for (const row of s.ledger) {
    if (before > s.run.capTokens) violated = `${row.stepKey} started at ${before} tokens with cap ${s.run.capTokens}`;
    before += row.inputTokens + row.outputTokens;
  }
  const ok = violated === null && s.run.usedTokens <= s.run.capTokens && s.run.usedUsd <= s.run.capUsd + 1e-9;
  record(`${name} · no step executed after the cap was reached`, ok, {
    "final tokens": `${s.run.usedTokens} / ${s.run.capTokens}`,
    "final usd": `${s.run.usedUsd.toFixed(6)} / ${s.run.capUsd}`,
    "final seconds": `${Math.round((Date.parse(s.run.finishedAt ?? new Date().toISOString()) - Date.parse(s.run.startedAt)) / 1000)} / ${s.run.capSeconds}`,
    violation: violated ?? "none",
  });
  return ok;
}

async function scenarioGenerous() {
  const runId = await startRun(
    "Incident note: at 03:12 the payments queue backed up to 40k messages after a retry storm; we shed load at 03:20 and drained by 04:05. Give me: (1) the cause, (2) the action taken, (3) one follow-up.",
    { capTokens: 100_000, capUsd: 1, capSeconds: 300, negotiate: true, autoApproveUnderUsd: 0.5 },
  );
  console.log(`  run ${runId}: generous envelope 100k tokens / $1 / 300s`);
  const s = await waitFor(runId, (x) => TERMINAL.has(x.run.status), {
    timeoutMs: 420_000,
    label: "terminal status",
  });
  const rc = s.reconciliation;
  record("generous envelope · runs to completion", s.run.status === "completed", {
    status: s.run.status,
    "ledger rows": s.ledger.length,
    "tokens used": `${s.run.usedTokens} / ${s.run.capTokens}`,
    "usd used": `${s.run.usedUsd.toFixed(6)} / ${s.run.capUsd}`,
    "total within cap": s.run.usedTokens <= s.run.capTokens && s.run.usedUsd <= s.run.capUsd,
    "reconciliation delta (tokens)": rc.delta.totalTokens,
    "reconciliation delta ($)": rc.delta.usd,
    "recon verdict": `${rc.reconciles ? "reconciles" : "does not reconcile"} — ${rc.reasons.join("; ")}`,
    "reported vs estimated rows": `${rc.ledger.reportedCalls} reported / ${rc.ledger.estimatedCalls} estimated`,
    "tokeniser estimate vs reported": `${rc.tokeniserAll.totalTokens} vs ${rc.providerReported.totalTokens} tokens`,
  });
  const a = checkLedgerIntegrity("generous envelope", s);
  const b = checkNoStepAfterCap("generous envelope", s);
  return a && b && s.run.status === "completed";
}

async function scenarioAutoTier() {
  // Same envelope as the denial scenario; only APPROVE_UNDER_USD differs, so the
  // two together show the tier boundary deciding the outcome, not the task.
  const runId = await startRun(multiPointTask(12), {
    capTokens: 2_500,
    capUsd: 1,
    capSeconds: 600,
    negotiate: true,
    autoApproveUnderUsd: 0.5,
  });
  console.log(`  run ${runId}: auto-approve tier, 2.5k tokens / $1 / 600s`);
  const s = await waitFor(runId, (x) => TERMINAL.has(x.run.status), {
    timeoutMs: 420_000,
    label: "terminal status",
  });
  const auto = s.approvals.filter((a) => a.status === "auto-approved");
  const granted = auto.find((a) => (a.newCapTokens ?? 0) > 0);
  const stepsAfterGrant = granted ? s.ledger.filter((r) => Date.parse(r.createdAt) > Date.parse(granted.decidedAt ?? "")) : [];
  record(
    "auto-approve tier · a request priced under APPROVE_UNDER_USD is granted without a human and the run keeps going",
    auto.length > 0 && granted !== undefined && s.run.usedTokens <= s.run.capTokens,
    {
      status: s.run.status,
      "requests filed": s.approvals.length,
      "auto-approved": auto.length,
      "caps written by the grant": granted ? `${granted.newCapTokens} tok / $${granted.newCapUsd} / ${granted.newCapSeconds}s` : "none",
      "steps executed after the grant": stepsAfterGrant.length,
      "tokens used": `${s.run.usedTokens} / ${s.run.capTokens}`,
      transcript: s.negotiations.map((n) => n.kind).join(" -> "),
    },
  );
  const a = checkLedgerIntegrity("auto-approve tier", s);
  const b = checkNoStepAfterCap("auto-approve tier", s);
  return a && b && auto.length > 0 && granted !== undefined;
}

async function scenarioTight() {
  // The envelope is the spec's 8k / $0.02 / 20s; the task is sized so that the
  // envelope genuinely binds. A three-step task fits inside 8k tokens and the
  // scenario would "pass" by completing, which tests nothing.
  const runId = await startRun(multiPointTask(12), {
    capTokens: 8_000,
    capUsd: 0.02,
    capSeconds: 20,
    negotiate: true,
    autoApproveUnderUsd: 0.0000001,
  });
  console.log(`  run ${runId}: tight envelope 8k tokens / $0.02 / 20s`);
  const s = await waitFor(runId, (x) => TERMINAL.has(x.run.status), {
    timeoutMs: 300_000,
    label: "terminal status",
  });
  const refusal = s.negotiations.filter((n) => n.kind === "refusal").map((n) => JSON.parse(n.payload));
  const replan = s.negotiations.filter((n) => n.kind === "replan");
  const stoppedCleanly = ["refused", "partial-result", "completed"].includes(s.run.status);
  const namedResource = s.run.status !== "refused" || ["tokens", "usd", "time"].includes(s.run.refuseAt);
  // The envelope must actually bind: a plain completion with no refusal, no
  // re-plan and no budget request means the cap never bit and nothing was proved.
  const bound = refusal.length > 0 || replan.length > 0 || s.approvals.length > 0;
  record(
    "tight envelope · replans inside the remainder or ends REFUSED with a named resource",
    bound && namedResource && stoppedCleanly,
    {
      status: s.run.status,
      "envelope bound": bound
        ? `yes (${refusal.length ? "refusal" : replan.length ? "re-plan" : `budget request #${s.approvals[0].id} ${s.approvals[0].status}`})`
        : "NO — the run completed without the cap ever binding",
      "refuse reason": s.run.refuseReason ?? "-",
      "refused at resource": s.run.refuseAt ?? "-",
      "stop reason": s.run.stopReason ?? "-",
      refusals: refusal.length,
      replans: replan.length,
      "refusal detail": refusal.map((r) => `${r.at}: needed ${r.neededTokens}, headroom ${r.remainingTokenEquivalent}`).join(" | ") || "none",
      "ledger rows": s.ledger.length,
      "tokens used": `${s.run.usedTokens} / ${s.run.capTokens}`,
      "seconds budget": `${s.run.capSeconds}`,
    },
  );
  const a = checkLedgerIntegrity("tight envelope", s);
  const b = checkNoStepAfterCap("tight envelope", s);
  return a && b && stoppedCleanly && namedResource && bound;
}

async function scenarioCapBypass() {
  const items = Array.from({ length: 15 }, (_, i) => `item ${i + 1}`).join(", ");
  const capTokens = 3_000;
  const runId = await startRun(
    `Handle each of these ${items} as its own separate step, one step per item, do not combine them: ${items}.`,
    { capTokens, capUsd: 1, capSeconds: 600, negotiate: true, autoApproveUnderUsd: 0.0000001 },
  );
  console.log(`  run ${runId}: cap-bypass attempt against a ${capTokens}-token envelope`);

  // If a human-tier request appears, deny it so the scenario tests the cap and
  // not the approval queue.
  const watch = setInterval(async () => {
    try {
      const current = await state(runId);
      if (current.run.status === "awaiting-approval") {
        for (const approval of current.approvals.filter((a) => a.status === "pending")) {
          console.log(`    denying pending request #${approval.id} to keep the bypass scenario about the cap`);
          await api(`/api/approvals/${approval.id}`, {
            method: "POST",
            body: JSON.stringify({ decision: "deny", note: "verify: cap-bypass scenario" }),
          });
        }
      }
    } catch {
      /* transient */
    }
  }, 4000);

  let s;
  try {
    s = await waitFor(runId, (x) => TERMINAL.has(x.run.status), { timeoutMs: 420_000, label: "terminal status" });
  } finally {
    clearInterval(watch);
  }

  const plan = s.run.planJson ? JSON.parse(s.run.planJson) : null;
  const planned = plan?.estimatedTotalTokens ?? 0;
  const stepCount = plan?.steps?.length ?? 0;
  const refusal = s.negotiations.filter((n) => n.kind === "refusal").map((n) => JSON.parse(n.payload));
  const neededMax = Math.max(0, ...refusal.map((r) => r.neededTokens));
  // What the app must actually pay for the plan: the gate prices a step at its
  // prompt estimate plus the output ceiling, which is far above the model's own
  // optimistic `estimatedTokens`. Report both rather than picking the flattering one.
  const gatePricedTotal = stepCount * (neededMax || 0);
  const ratio = Math.max(planned, gatePricedTotal) / capTokens;
  record(
    "cap-bypass attempt · refuses a plan far larger than the cap instead of executing it",
    s.run.usedTokens <= capTokens &&
      ratio >= 3 &&
      (s.run.status === "refused" || s.run.status === "partial-result"),
    {
      status: s.run.status,
      "planned steps": stepCount,
      "planned tokens (model's own figure)": `${planned} (${(planned / capTokens).toFixed(1)}x cap)`,
      "planned tokens (as the gate prices them)": `${gatePricedTotal} (${(gatePricedTotal / capTokens).toFixed(1)}x cap)`,
      "largest single-step need priced by the gate": neededMax,
      "refused at": s.run.refuseAt ?? "-",
      "tokens actually used": `${s.run.usedTokens} / ${capTokens}`,
      "ledger rows": s.ledger.length,
      "envelope held": s.run.usedTokens <= capTokens,
    },
  );
  const a = checkLedgerIntegrity("cap-bypass attempt", s);
  const b = checkNoStepAfterCap("cap-bypass attempt", s);
  return a && b && s.run.usedTokens <= capTokens;
}

/**
 * A task that reliably produces a multi-step plan. Scenarios that need the
 * envelope to bind cannot rely on the model volunteering a long plan, so the
 * work is stated as an explicit list of points to handle one at a time.
 */
const multiPointTask = (n) =>
  `Analyse this incident one point at a time, one step per point, never combining points: ` +
  Array.from({ length: n }, (_, i) => i + 1).join(", ") +
  `. Context: at 03:12 the payments queue backed up to 40k messages after a retry storm; ` +
  `load was shed at 03:20 and the queue drained by 04:05.`;

async function scenarioDeny() {
  // 2.5k tokens buys the planner plus about two steps of a twelve-point plan, so
  // the gate is certain to block and file a request whatever the model plans.
  const runId = await startRun(multiPointTask(12), {
    capTokens: 2_500,
    capUsd: 1,
    capSeconds: 600,
    negotiate: true,
    autoApproveUnderUsd: 0.0000001,
  });
  console.log(`  run ${runId}: approval path with APPROVE_UNDER_USD ~ 0, then a denial`);
  const paused = await waitFor(runId, (x) => x.run.status === "awaiting-approval" && x.approvals.some((a) => a.status === "pending"), {
    timeoutMs: 420_000,
    label: "awaiting-approval",
  });
  const approval = paused.approvals.find((a) => a.status === "pending");
  console.log(
    `  request #${approval.id}: "${approval.justification}" asking ${approval.wantTokens} tokens / $${approval.wantUsd} (tier ${approval.tier})`,
  );

  await api(`/api/approvals/${approval.id}`, {
    method: "POST",
    body: JSON.stringify({ decision: "deny", note: "verify: denying to check the clean-stop path", decidedBy: "verify" }),
  });

  const s = await waitFor(
    runId,
    (x) => TERMINAL.has(x.run.status) && x.approvals.some((a) => a.id === approval.id && a.status === "denied"),
    { timeoutMs: 300_000, label: "clean stop after denial" },
  );

  const report = s.run.costReportJson ? JSON.parse(s.run.costReportJson) : null;
  record(
    "approval path · a denial stops the run cleanly with a partial result and a cost report",
    s.run.status === "partial-result" && report !== null && s.run.stopReason === "denied",
    {
      status: s.run.status,
      "stop reason": s.run.stopReason,
      "decision recorded": `${approval.decidedBy ?? "verify"} denied request #${approval.id}`,
      "partial result present": s.run.resultJson !== null,
      "partial result keys": s.run.resultJson ? Object.keys(JSON.parse(s.run.resultJson)).join(", ") : "none",
      "summarised by model": s.run.resultJson ? JSON.parse(s.run.resultJson).summarisedByModel : "n/a",
      "cost report tokens": report ? `${report.tokens.used} / ${report.tokens.cap}` : "none",
      "cost report usd": report ? `${report.usd.used} / ${report.usd.cap}` : "none",
      "cost report seconds": report ? `${report.seconds.elapsed} / ${report.seconds.cap}` : "none",
      "cost report rows": report ? `${report.ledgerRows} (${report.estimatedRows} estimated)` : "none",
      "findings retained": s.findings.length,
      transcript: s.negotiations.map((n) => `${n.kind}(${n.actor})`).join(" -> "),
    },
  );
  const a = checkLedgerIntegrity("approval denial", s);
  const b = checkNoStepAfterCap("approval denial", s);
  return a && b && s.run.status === "partial-result" && report !== null;
}

async function main() {
  console.log("allowance verification");
  console.log("======================");
  const notes = await ensureStack();
  for (const note of notes) console.log(`  · ${note}`);

  const health = await api("/api/health");
  const probe = await api("/api/test-connection", { method: "POST", body: JSON.stringify({ settings: {} }) });
  console.log(`  · inference under test: ${health.model} @ ${health.baseUrl} (HTTP ${probe.status}, ${probe.latencyMs} ms)`);
  console.log(
    `  · provider reports usage: ${probe.usage ? `yes (prompt ${probe.usage.prompt_tokens}, completion ${probe.usage.completion_tokens})` : "no — estimates only"}`,
  );
  console.log(`  · ledger db: ${health.db}`);

  const checks = [];
  // VERIFY_ONLY=generous,tight  runs a subset while iterating.
  const only = (process.env.VERIFY_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const wanted = (name) => only.length === 0 || only.some((needle) => name.includes(needle));

  if (wanted("generous")) checks.push(["1. generous envelope runs to completion", await scenarioGenerous()]);
  if (wanted("tight")) checks.push(["2. tight envelope replans or refuses", await scenarioTight()]);
  if (wanted("bypass")) checks.push(["3. cap-bypass plan is refused, not executed", await scenarioCapBypass()]);
  if (wanted("deny")) checks.push(["4. denied budget request stops cleanly", await scenarioDeny()]);
  if (wanted("auto")) checks.push(["5. auto-approve tier grants without a human", await scenarioAutoTier()]);

  console.log("\n======================");
  let failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} scenarios passed. Individual assertions: ${results.filter((r) => r.ok).length}/${results.length}.`,
  );

  if (failed.length) {
    console.log(`\nfailing scenarios: ${failed.map(([n]) => n).join(", ")}`);
    cleanup();
    process.exit(1);
  }
  cleanup();
  console.log("\nALL CHECKS PASSED");
}

main().catch((error) => {
  console.error(`\n[FATAL] ${error?.stack ?? error}`);
  cleanup();
  process.exit(1);
});
