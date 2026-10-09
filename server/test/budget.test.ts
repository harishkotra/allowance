import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRow } from "../../shared/types";
import {
  commitLedgerAndCounters,
  createRun,
  getDb,
  getLedger,
  getRun,
  listRuns,
  openDb,
  updateRun,
} from "../src/db";
import {
  MIN_CALL_TOKENS,
  costUsdOf,
  gateFor,
  snapshotEnvelope,
  usdToTokens,
} from "../src/agent/budget";
import { estimateRequestTokens, resolveUsage, tokenize } from "../src/usage";

const dbFile = join(tmpdir(), `allowance-test-${process.pid}.db`);
process.env.LEDGER_DB = dbFile;

const prices = { per1kInput: 0.00015, per1kOutput: 0.0006 };

interface RunOverrides {
  capTokens?: number;
  capUsd?: number;
  capSeconds?: number;
  autoApproveUnderUsd?: number;
  negotiate?: boolean;
}

function newRun(over: RunOverrides = {}): RunRow {
  const runId = `test-${Math.random().toString(16).slice(2, 10)}`;
  const now = Date.now();
  const capSeconds = over.capSeconds ?? 90;
  createRun({
    runId,
    task: "test task",
    model: "test-model",
    baseUrl: "http://localhost:1234/v1",
    capTokens: over.capTokens ?? 40_000,
    capUsd: over.capUsd ?? 0.25,
    capSeconds,
    autoApproveUnderUsd: over.autoApproveUnderUsd ?? 0.05,
    negotiate: over.negotiate ?? true,
    per1kInput: prices.per1kInput,
    per1kOutput: prices.per1kOutput,
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + capSeconds * 1000).toISOString(),
  });
  return getRun(runId)!;
}

function addUsage(runId: string, inputTokens: number, outputTokens: number, stepKey: string) {
  const run = getRun(runId)!;
  const envelope = snapshotEnvelope(run, Date.now());
  commitLedgerAndCounters({
    runId,
    stepKey,
    step: 1,
    phase: "execute",
    model: run.model,
    inputTokens,
    outputTokens,
    usd: costUsdOf(inputTokens, outputTokens, prices),
    cumulativePct: envelope.cumulativePct,
    estimated: false,
    reportedInput: inputTokens,
    reportedOutput: outputTokens,
    estInput: inputTokens,
    estOutput: outputTokens,
    rawPresent: true,
    createdAt: new Date().toISOString(),
  });
  return getRun(runId)!;
}

before(() => {
  rmSync(dbFile, { force: true });
  rmSync(`${dbFile}-wal`, { force: true });
  rmSync(`${dbFile}-shm`, { force: true });
  openDb(dbFile);
});

after(() => {
  getDb().close();
  rmSync(dbFile, { force: true });
});

describe("tokeniser and usage resolution", () => {
  it("counts tokens with a real tokeniser", () => {
    assert.equal(tokenize("hello world"), 2);
    assert.ok(estimateRequestTokens([{ role: "user", content: "hello world" }]) > 2);
  });

  it("charges reported usage when the provider supplies it", () => {
    const resolved = resolveUsage({
      raw: { usage: { prompt_tokens: 120, completion_tokens: 40 } },
      requestMessages: [{ role: "user", content: "hi" }],
      completionText: "yo",
    });
    assert.equal(resolved.estimated, false);
    assert.equal(resolved.input, 120);
    assert.equal(resolved.output, 40);
    // The estimate is still computed so the reconciliation table can compare.
    assert.ok(resolved.estInput > 0);
    assert.equal(resolved.reportedInput, 120);
  });

  it("falls back to an estimate and labels it when usage is absent", () => {
    const resolved = resolveUsage({
      raw: { choices: [{ message: { content: "yo" } }] },
      requestMessages: [{ role: "user", content: "hello there friend" }],
      completionText: "yo",
    });
    assert.equal(resolved.estimated, true);
    assert.equal(resolved.usagePresent, false);
    assert.equal(resolved.reportedInput, null);
    assert.equal(resolved.input, resolved.estInput);
  });

  it("never mixes: absent usage still yields est values, not zero", () => {
    const resolved = resolveUsage({ raw: null, requestMessages: [], completionText: "" });
    assert.equal(resolved.estimated, true);
    assert.equal(resolved.rawPresent, false);
  });
});

describe("envelope maths", () => {
  it("converts dollars to tokens at the dearer price", () => {
    // $0.0006/1k output => $0.0006 buys 1000 tokens at the conservative rate.
    assert.equal(usdToTokens(0.0006, prices), 1000);
    assert.ok(usdToTokens(0.0006, prices) < 4000);
  });

  it("prices a call from the price table, not a constant", () => {
    const cheap = costUsdOf(1000, 1000, { per1kInput: 0.00015, per1kOutput: 0.0006 });
    const dear = costUsdOf(1000, 1000, { per1kInput: 0.01, per1kOutput: 0.03 });
    assert.ok(dear > cheap * 5);
  });

  it("names the binding resource when the plan does not fit", () => {
    const run = newRun();
    addUsage(run.runId, 39_500, 0, "seed");
    const decision = gateFor(getRun(run.runId)!, Date.now(), 5_000);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "envelope_exhausted");
    assert.equal(decision.at, "tokens");
    assert.ok(decision.canReplan, "still has room for a smaller call");
  });

  it("refuses on the money cap even with tokens left", () => {
    const run = newRun({ capUsd: 0.001 });
    addUsage(run.runId, 1_000, 1_000, "seed");
    const refreshed = getRun(run.runId)!;
    const decision = gateFor(refreshed, Date.now(), 50_000);
    assert.equal(decision.allowed, false);
    assert.equal(decision.at, "usd");
  });

  it("prices time headroom off the envelope, not observed throughput", () => {
    // Regression: one slow first call used to make the implied rate ~5 tok/s,
    // which then refused every later step despite most tokens still unspent.
    const run = newRun({ capTokens: 40_000, capSeconds: 90 });
    addUsage(run.runId, 200, 35, "slow-first-call");
    const now = Date.now();
    updateRun(run.runId, {
      startedAt: new Date(now - 40_000).toISOString(),
      deadlineAt: new Date(now + 50_000).toISOString(),
    });
    const env = snapshotEnvelope(getRun(run.runId)!, now);
    assert.ok(Math.abs(env.rateTokensPerSecond - 40_000 / 90) < 0.001);
    assert.ok(
      env.remainingTokenEquivalent > 20_000,
      `expected >20k token-equivalents, got ${env.remainingTokenEquivalent}`,
    );
    assert.equal(env.binding, "time", "time is the binding resource at 44s of 90s");
  });

  it("refuses with at:'time' once the deadline passes, mid-plan", () => {
    const run = newRun();
    const future = Date.parse(run.deadlineAt) + 1_000;
    const decision = gateFor(run, future, 10);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "deadline");
    assert.equal(decision.at, "time");
    assert.equal(decision.canReplan, false);
  });

  it("allows a call that fits inside the token-equivalent headroom", () => {
    const run = newRun();
    const decision = gateFor(run, Date.now(), 1_000);
    assert.equal(decision.allowed, true);
    assert.equal(decision.at, null);
  });

  it("shrinks headroom as the ledger grows", () => {
    const run = newRun();
    const before = snapshotEnvelope(run, Date.now());
    addUsage(run.runId, 10_000, 5_000, "big");
    const after = snapshotEnvelope(getRun(run.runId)!, Date.now());
    assert.equal(after.remainingTokens, before.remainingTokens - 15_000);
    assert.equal(after.usedTokens, 15_000);
    assert.ok(after.remainingTokenEquivalent <= before.remainingTokenEquivalent);
    assert.ok(after.cumulativePct >= before.cumulativePct);
  });
});

describe("ledger durability invariants", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM ledger").run();
    getDb().prepare("DELETE FROM runs").run();
  });

  it("writes exactly one row per step key, even when replayed", () => {
    const run = newRun();
    const entry = {
      runId: run.runId,
      stepKey: "exec:0",
      step: 1,
      phase: "execute" as const,
      model: run.model,
      inputTokens: 500,
      outputTokens: 200,
      usd: costUsdOf(500, 200, prices),
      cumulativePct: 1.75,
      estimated: false,
      reportedInput: 500,
      reportedOutput: 200,
      estInput: 498,
      estOutput: 199,
      rawPresent: true,
      createdAt: new Date().toISOString(),
    };
    commitLedgerAndCounters(entry);
    commitLedgerAndCounters(entry); // replay of the same Inngest step
    const rows = getLedger(run.runId);
    assert.equal(rows.length, 1);
    assert.equal(getRun(run.runId)!.usedTokens, 700);
    assert.equal(getRun(run.runId)!.executedSteps, 1);
  });

  it("keeps stored counters equal to the sum of ledger rows", () => {
    const run = newRun();
    addUsage(run.runId, 100, 50, "a");
    addUsage(run.runId, 200, 60, "b");
    addUsage(run.runId, 300, 70, "c");
    const rows = getLedger(run.runId);
    const summed = rows.reduce((t, r) => t + r.inputTokens + r.outputTokens, 0);
    const refreshed = getRun(run.runId)!;
    assert.equal(refreshed.usedTokens, summed);
    assert.equal(refreshed.executedSteps, rows.length);
    const usd = rows.reduce((t, r) => t + r.usd, 0);
    assert.ok(Math.abs(refreshed.usedUsd - usd) < 1e-12);
  });

  it("never exceeds the cap once the gate is respected", () => {
    const run = newRun({ capTokens: 1_000 });
    let guard = 0;
    while (guard++ < 50) {
      const current = getRun(run.runId)!;
      const decision = gateFor(current, Date.now(), 300);
      if (!decision.allowed) break;
      addUsage(run.runId, 200, 100, `loop:${guard}`);
    }
    const final = getRun(run.runId)!;
    assert.ok(final.usedTokens <= final.capTokens, `used ${final.usedTokens} > cap ${final.capTokens}`);
    assert.ok(listRuns().length >= 1);
    assert.ok(MIN_CALL_TOKENS > 0);
  });
});
