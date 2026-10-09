import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import type {
  ApprovalRow,
  FindingRow,
  LedgerRow,
  NegotiationRow,
  RunRow,
} from "../../shared/types";

let db: Database.Database | undefined;

export function dbPath(): string {
  return process.env.LEDGER_DB ?? "./allowance.db";
}

/**
 * The envelope counters and the ledger are written in one transaction so a run
 * can never have a counter that disagrees with the rows beneath it.
 */
export function openDb(path = dbPath()): Database.Database {
  if (db) return db;
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function getDb(): Database.Database {
  return openDb();
}

function migrate(d: Database.Database): void {
  d.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    run_id                TEXT PRIMARY KEY,
    task                  TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'idle',
    model                 TEXT NOT NULL,
    base_url              TEXT NOT NULL,
    cap_tokens            INTEGER NOT NULL,
    cap_usd               REAL NOT NULL,
    cap_seconds           REAL NOT NULL,
    used_tokens           INTEGER NOT NULL DEFAULT 0,
    used_usd              REAL NOT NULL DEFAULT 0,
    auto_approve_under_usd REAL NOT NULL,
    negotiate             INTEGER NOT NULL DEFAULT 1,
    price_in_per_1k       REAL NOT NULL,
    price_out_per_1k      REAL NOT NULL,
    started_at            TEXT NOT NULL,
    deadline_at           TEXT NOT NULL,
    finished_at           TEXT,
    inngest_run_id        TEXT,
    stop_reason           TEXT,
    refuse_reason         TEXT,
    refuse_at             TEXT,
    deadline_breached     INTEGER NOT NULL DEFAULT 0,
    plan_json             TEXT,
    result_json           TEXT,
    cost_report_json      TEXT,
    executed_steps        INTEGER NOT NULL DEFAULT 0,
    error                 TEXT
  );

  CREATE TABLE IF NOT EXISTS ledger (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step_key        TEXT NOT NULL,
    step            INTEGER NOT NULL,
    phase           TEXT NOT NULL,
    action          TEXT,
    model           TEXT NOT NULL,
    input_tokens    INTEGER NOT NULL,
    output_tokens   INTEGER NOT NULL,
    usd             REAL NOT NULL,
    cumulative_pct  REAL NOT NULL,
    estimated       INTEGER NOT NULL,
    reported_input  INTEGER,
    reported_output INTEGER,
    est_input       INTEGER NOT NULL,
    est_output      INTEGER NOT NULL,
    raw_present     INTEGER NOT NULL DEFAULT 0,
    tool_names      TEXT,
    created_at      TEXT NOT NULL,
    UNIQUE (run_id, step_key)
  );
  CREATE INDEX IF NOT EXISTS ledger_run_idx ON ledger(run_id, step);

  CREATE TABLE IF NOT EXISTS approvals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step           INTEGER NOT NULL,
    requested_at   TEXT NOT NULL,
    justification  TEXT NOT NULL,
    want_tokens    INTEGER NOT NULL,
    want_usd       REAL NOT NULL,
    want_seconds   REAL NOT NULL,
    est_cost_usd   REAL NOT NULL,
    tier           TEXT NOT NULL,
    status         TEXT NOT NULL,
    decided_at     TEXT,
    decided_by     TEXT,
    note           TEXT,
    new_cap_tokens  INTEGER,
    new_cap_usd     REAL,
    new_cap_seconds REAL,
    UNIQUE (run_id, step)
  );

  CREATE TABLE IF NOT EXISTS negotiations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    actor      TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, seq)
  );

  CREATE TABLE IF NOT EXISTS findings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    step       INTEGER NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, key)
  );
  `);
}

const rowToRun = (r: any): RunRow => ({
  runId: r.run_id,
  task: r.task,
  status: r.status,
  model: r.model,
  baseUrl: r.base_url,
  capTokens: r.cap_tokens,
  capUsd: r.cap_usd,
  capSeconds: r.cap_seconds,
  usedTokens: r.used_tokens,
  usedUsd: r.used_usd,
  autoApproveUnderUsd: r.auto_approve_under_usd,
  negotiate: !!r.negotiate,
  per1kInput: r.price_in_per_1k,
  per1kOutput: r.price_out_per_1k,
  startedAt: r.started_at,
  deadlineAt: r.deadline_at,
  finishedAt: r.finished_at ?? null,
  inngestRunId: r.inngest_run_id ?? null,
  stopReason: r.stop_reason ?? null,
  refuseReason: r.refuse_reason ?? null,
  refuseAt: r.refuse_at ?? null,
  deadlineBreached: !!r.deadline_breached,
  planJson: r.plan_json ?? null,
  resultJson: r.result_json ?? null,
  costReportJson: r.cost_report_json ?? null,
  executedSteps: r.executed_steps,
  error: r.error ?? null,
});

export interface NewRun {
  runId: string;
  task: string;
  model: string;
  baseUrl: string;
  capTokens: number;
  capUsd: number;
  capSeconds: number;
  autoApproveUnderUsd: number;
  negotiate: boolean;
  per1kInput: number;
  per1kOutput: number;
  startedAt: string;
  deadlineAt: string;
}

export function createRun(input: NewRun): RunRow {
  getDb()
    .prepare(
      `INSERT INTO runs (run_id, task, status, model, base_url, cap_tokens, cap_usd, cap_seconds,
        auto_approve_under_usd, negotiate, price_in_per_1k, price_out_per_1k, started_at, deadline_at)
       VALUES (@runId, @task, 'idle', @model, @baseUrl, @capTokens, @capUsd, @capSeconds,
        @autoApproveUnderUsd, @negotiate, @per1kInput, @per1kOutput, @startedAt, @deadlineAt)`,
    )
    .run({ ...input, negotiate: input.negotiate ? 1 : 0 });
  return getRun(input.runId)!;
}

export function getRun(runId: string): RunRow | undefined {
  const r = getDb().prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
  return r ? rowToRun(r) : undefined;
}

export function listRuns(limit = 50): RunRow[] {
  return getDb()
    .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
    .all(limit)
    .map(rowToRun);
}

export function updateRun(runId: string, patch: Partial<RunRow>): RunRow | undefined {
  const map: Record<string, keyof RunRow> = {
    status: "status",
    used_tokens: "usedTokens",
    used_usd: "usedUsd",
    cap_tokens: "capTokens",
    cap_usd: "capUsd",
    cap_seconds: "capSeconds",
    started_at: "startedAt",
    deadline_at: "deadlineAt",
    finished_at: "finishedAt",
    inngest_run_id: "inngestRunId",
    stop_reason: "stopReason",
    refuse_reason: "refuseReason",
    refuse_at: "refuseAt",
    deadline_breached: "deadlineBreached",
    plan_json: "planJson",
    result_json: "resultJson",
    cost_report_json: "costReportJson",
    executed_steps: "executedSteps",
    error: "error",
  };
  const sets: string[] = [];
  const values: Record<string, unknown> = { runId };
  for (const [column, field] of Object.entries(map)) {
    if (!(field in patch)) continue;
    const v = (patch as Record<string, unknown>)[field];
    values[column] = typeof v === "boolean" ? (v ? 1 : 0) : v;
    sets.push(`${column} = @${column}`);
  }
  if (!sets.length) return getRun(runId);
  getDb().prepare(`UPDATE runs SET ${sets.join(", ")} WHERE run_id = @runId`).run(values);
  return getRun(runId);
}

export const rowToLedger = (r: any): LedgerRow => ({
  id: r.id,
  runId: r.run_id,
  stepKey: r.step_key,
  step: r.step,
  phase: r.phase,
  action: r.action ?? null,
  model: r.model,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  usd: r.usd,
  cumulativePct: r.cumulative_pct,
  estimated: !!r.estimated,
  reportedInput: r.reported_input ?? null,
  reportedOutput: r.reported_output ?? null,
  estInput: r.est_input,
  estOutput: r.est_output,
  toolNames: r.tool_names ?? null,
  createdAt: r.created_at,
});

export interface LedgerInsert {
  runId: string;
  stepKey: string;
  step: number;
  phase: LedgerRow["phase"];
  action?: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  cumulativePct: number;
  estimated: boolean;
  reportedInput: number | null;
  reportedOutput: number | null;
  estInput: number;
  estOutput: number;
  rawPresent: boolean;
  toolNames?: string | null;
  createdAt: string;
}

/**
 * Idempotent on (run_id, step_key): an Inngest step that is retried or replayed
 * rewrites the same row rather than double-counting the envelope.
 */
export function commitLedgerAndCounters(entry: LedgerInsert): void {
  const tx = getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO ledger (run_id, step_key, step, phase, action, model, input_tokens, output_tokens,
            usd, cumulative_pct, estimated, reported_input, reported_output, est_input, est_output,
            raw_present, tool_names, created_at)
         VALUES (@runId, @stepKey, @step, @phase, @action, @model, @inputTokens, @outputTokens,
            @usd, @cumulativePct, @estimated, @reportedInput, @reportedOutput, @estInput, @estOutput,
            @rawPresent, @toolNames, @createdAt)
         ON CONFLICT(run_id, step_key) DO UPDATE SET
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            usd = excluded.usd,
            cumulative_pct = excluded.cumulative_pct,
            estimated = excluded.estimated,
            reported_input = excluded.reported_input,
            reported_output = excluded.reported_output,
            est_input = excluded.est_input,
            est_output = excluded.est_output,
            tool_names = excluded.tool_names`,
      )
      .run({
        ...entry,
        estimated: entry.estimated ? 1 : 0,
        rawPresent: entry.rawPresent ? 1 : 0,
        action: entry.action ?? null,
        toolNames: entry.toolNames ?? null,
      });

    getDb()
      .prepare(
        `UPDATE runs SET
           used_tokens = (SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM ledger WHERE run_id = @runId),
           used_usd    = (SELECT COALESCE(SUM(usd), 0) FROM ledger WHERE run_id = @runId),
           executed_steps = (SELECT COUNT(*) FROM ledger WHERE run_id = @runId)
         WHERE run_id = @runId`,
      )
      .run({ runId: entry.runId });
  });
  tx();
}

export function getLedger(runId: string): LedgerRow[] {
  return getDb()
    .prepare("SELECT * FROM ledger WHERE run_id = ? ORDER BY step, id")
    .all(runId)
    .map(rowToLedger);
}

export const rowToApproval = (r: any): ApprovalRow => ({
  id: r.id,
  runId: r.run_id,
  step: r.step,
  requestedAt: r.requested_at,
  justification: r.justification,
  wantTokens: r.want_tokens,
  wantUsd: r.want_usd,
  wantSeconds: r.want_seconds,
  estCostUsd: r.est_cost_usd,
  tier: r.tier,
  status: r.status,
  decidedAt: r.decided_at ?? null,
  decidedBy: r.decided_by ?? null,
  note: r.note ?? null,
  newCapTokens: r.new_cap_tokens ?? null,
  newCapUsd: r.new_cap_usd ?? null,
  newCapSeconds: r.new_cap_seconds ?? null,
});

export function insertApproval(a: {
  runId: string;
  step: number;
  requestedAt: string;
  justification: string;
  wantTokens: number;
  wantUsd: number;
  wantSeconds: number;
  estCostUsd: number;
  tier: string;
  status: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO approvals (run_id, step, requested_at, justification, want_tokens, want_usd,
         want_seconds, est_cost_usd, tier, status)
       VALUES (@runId, @step, @requestedAt, @justification, @wantTokens, @wantUsd, @wantSeconds,
         @estCostUsd, @tier, @status)
       ON CONFLICT(run_id, step) DO NOTHING`,
    )
    .run(a);
}

export function getApprovalAtStep(runId: string, step: number): ApprovalRow | undefined {
  const r = getDb().prepare("SELECT * FROM approvals WHERE run_id = ? AND step = ?").get(runId, step);
  return r ? rowToApproval(r) : undefined;
}

export function getApprovalById(id: number): ApprovalRow | undefined {
  const r = getDb().prepare("SELECT * FROM approvals WHERE id = ?").get(id);
  return r ? rowToApproval(r) : undefined;
}

export function listApprovals(runId: string): ApprovalRow[] {
  return getDb()
    .prepare("SELECT * FROM approvals WHERE run_id = ? ORDER BY id")
    .all(runId)
    .map(rowToApproval);
}

export function decideApproval(
  id: number,
  decision: "approved" | "denied",
  decidedBy: string,
  note: string | null,
): ApprovalRow | undefined {
  getDb()
    .prepare(
      `UPDATE approvals SET status = @decision, decided_at = @decidedAt, decided_by = @decidedBy,
         note = @note WHERE id = @id AND status = 'pending'`,
    )
    .run({
      id,
      decision,
      decidedBy,
      note,
      decidedAt: new Date().toISOString(),
    });
  return getApprovalById(id);
}

/** Only the durable run calls this, from inside a step, when a grant is approved. */
export function applyGrant(
  approvalId: number,
  caps: { capTokens: number; capUsd: number; capSeconds: number; deadlineAt: string },
): void {
  getDb()
    .prepare(
      `UPDATE approvals SET new_cap_tokens = @capTokens, new_cap_usd = @capUsd,
         new_cap_seconds = @capSeconds WHERE id = @approvalId`,
    )
    .run({ ...caps, approvalId });
  getDb()
    .prepare(
      `UPDATE runs SET cap_tokens = @capTokens, cap_usd = @capUsd, cap_seconds = @capSeconds,
         deadline_at = @deadlineAt WHERE run_id = (SELECT run_id FROM approvals WHERE id = @approvalId)`,
    )
    .run({ ...caps, approvalId });
}

export function appendNegotiation(n: {
  runId: string;
  seq: number;
  kind: NegotiationRow["kind"];
  actor: NegotiationRow["actor"];
  payload: unknown;
  createdAt: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO negotiations (run_id, seq, kind, actor, payload, created_at)
       VALUES (@runId, @seq, @kind, @actor, @payload, @createdAt)
       ON CONFLICT(run_id, seq) DO UPDATE SET payload = excluded.payload`,
    )
    .run({ ...n, payload: typeof n.payload === "string" ? n.payload : JSON.stringify(n.payload) });
}

export const rowToNegotiation = (r: any): NegotiationRow => ({
  id: r.id,
  runId: r.run_id,
  seq: r.seq,
  kind: r.kind,
  actor: r.actor,
  payload: r.payload,
  createdAt: r.created_at,
});

export function listNegotiations(runId: string): NegotiationRow[] {
  return getDb()
    .prepare("SELECT * FROM negotiations WHERE run_id = ? ORDER BY seq")
    .all(runId)
    .map(rowToNegotiation);
}

export function upsertFinding(f: {
  runId: string;
  step: number;
  key: string;
  value: string;
  createdAt: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO findings (run_id, step, key, value, created_at)
       VALUES (@runId, @step, @key, @value, @createdAt)
       ON CONFLICT(run_id, key) DO UPDATE SET value = excluded.value, step = excluded.step`,
    )
    .run(f);
}

export const rowToFinding = (r: any): FindingRow => ({
  id: r.id,
  runId: r.run_id,
  step: r.step,
  key: r.key,
  value: r.value,
  createdAt: r.created_at,
});

export function listFindings(runId: string): FindingRow[] {
  return getDb().prepare("SELECT * FROM findings WHERE run_id = ? ORDER BY step, id").all(runId).map(rowToFinding);
}
