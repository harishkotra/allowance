import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunState } from "../../shared/types";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  decide,
  fetchState,
  fmtTokens,
  loadSettings,
  saveSettings,
  startRun,
  subscribeToRun,
} from "./lib/api";
import Gauges from "./components/Gauges";
import Ledger from "./components/Ledger";
import ApprovalInbox from "./components/ApprovalInbox";
import Negotiation from "./components/Negotiation";
import Reconciliation from "./components/Reconciliation";
import Settings from "./components/Settings";

const STATUS_STYLE: Record<string, string> = {
  idle: "#1b222b:text-neutral-300",
  running: "#121f29:text-[var(--color-accent)]",
  "awaiting-approval": "#3a2f14:text-[var(--color-warn)]",
  refused: "#2a1416:text-[var(--color-bad)]",
  completed: "#12291f:text-[var(--color-ok)]",
  "partial-result": "#2b2413:text-[var(--color-warn)]",
};

function StatusPill({ status }: { status: string }) {
  const [bg, color] = (STATUS_STYLE[status] ?? "#1b222b:text-neutral-300").split(":");
  return (
    <span
      className="rounded px-2 py-1 text-[11px] font-bold uppercase tracking-wider"
      style={{ background: bg, color }}
    >
      {status}
    </span>
  );
}

export default function App() {
  const [settings, setSettings] = useState(() => {
    try {
      return loadSettings();
    } catch {
      return DEFAULT_SETTINGS;
    }
  });
  const [task, setTask] = useState(
    "Read the incident note and give me three short findings: cause, action taken, follow-up. " +
      "Note: at 03:12 the payments queue backed up to 40k messages after a retry storm; load was shed at 03:20 and the queue drained by 04:05.",
  );
  const [state, setState] = useState<RunState | null>(null);
  const [runId, setRunId] = useState<string>(() => new URLSearchParams(location.search).get("run") ?? "");
  const [error, setError] = useState<string | null>(null);
  // Deep-linkable so the panel can be opened without a click (?settings=1).
  const [showSettings, setShowSettings] = useState(
    () => new URLSearchParams(location.search).get("settings") === "1",
  );
  const [submitting, setSubmitting] = useState(false);
  const poller = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const stopPolling = () => {
    if (poller.current) {
      clearInterval(poller.current);
      poller.current = null;
    }
  };

  // Live view. If the stream dies without a terminal state, fall back to
  // polling so the UI can never hang on a spinner.
  useEffect(() => {
    if (!runId) return;
    setError(null);
    const unsubscribe = subscribeToRun(
      runId,
      (next) => setState(next),
      () => stopPolling(),
    );
    const fallback = setInterval(async () => {
      try {
        setState(await fetchState(runId));
      } catch {
        /* server not up yet */
      }
    }, 2000);
    poller.current = fallback;
    return () => {
      unsubscribe();
      stopPolling();
    };
  }, [runId]);

  const onDecide = useCallback(
    async (id: number, decision: "approve" | "deny", note: string) => {
      setError(null);
      try {
        const response = await decide(id, decision, note);
        const next = (response as { state?: RunState }).state;
        if (next) setState(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const start = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const created = await startRun(task, settings);
      setRunId(created.runId);
      const params = new URLSearchParams(location.search);
      params.set("run", created.runId);
      history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
      setState(await fetchState(created.runId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const status = state?.run.status ?? "idle";
  const refused = status === "refused";
  const pending = useMemo(() => state?.approvals.filter((a) => a.status === "pending").length ?? 0, [state]);
  const refusalDetail = useMemo(() => {
    const last = state?.negotiations.filter((n) => n.kind === "refusal").slice(-1)[0];
    if (!last) return { needed: "n/a", headroom: "n/a" };
    try {
      const parsed = JSON.parse(last.payload) as { neededTokens?: number; remainingTokenEquivalent?: number };
      return {
        needed: fmtTokens(parsed.neededTokens ?? 0),
        headroom: fmtTokens(parsed.remainingTokenEquivalent ?? 0),
      };
    } catch {
      return { needed: "n/a", headroom: "n/a" };
    }
  }, [state]);

  return (
    <div className="mx-auto flex min-h-full max-w-[1500px] flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-edge)] pb-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-neutral-100">
            Allowance<span className="ml-2 text-xs font-normal text-[var(--color-muted)]">agent inside a hard envelope</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={status} />
          {state?.run.refuseAt && refused && (
            <span className="rounded bg-[#2a1416] px-2 py-1 text-[11px] font-semibold text-[var(--color-bad)]">
              {state.run.refuseReason ?? "envelope_exhausted"} → {state.run.refuseAt}
            </span>
          )}
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="rounded border border-[var(--color-edge)] px-3 py-1 text-xs text-neutral-300 hover:bg-[#161c24]"
          >
            {showSettings ? "Hide settings" : "Settings"}
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(320px,1fr)_minmax(420px,1.35fr)_minmax(340px,1fr)]">
        <div className="flex flex-col gap-4">
          <section className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-3">
            <label className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]" htmlFor="task">
              Task
            </label>
            <textarea
              id="task"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={5}
              className="mt-1 w-full resize-y rounded border border-[var(--color-edge)] bg-[#0e1217] p-2 text-xs leading-relaxed text-neutral-200 outline-none focus:border-[var(--color-accent)]"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={start}
                disabled={submitting || !task.trim()}
                className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs font-bold text-[#06121f] hover:brightness-110 disabled:opacity-50"
              >
                {submitting ? "Starting…" : "Run with envelope"}
              </button>
              <span className="text-[11px] text-[var(--color-muted)]">
                {settings.capTokens.toLocaleString()} tok · ${settings.capUsd} · {settings.capSeconds}s ·{" "}
                {settings.negotiate ? "negotiation on" : "negotiation off"}
              </span>
            </div>
            {error && (
              <p className="mt-2 rounded border border-[#5a2126] bg-[#2a1416] px-2 py-1.5 text-[11px] text-[var(--color-bad)]">
                {error}
              </p>
            )}
          </section>

          {state ? <Gauges gauges={state.gauges} status={status} /> : null}

          {refused && state && (
            <section className="rounded-lg border border-[#5a2126] bg-[#221012] p-3">
              <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--color-bad)]">Refused</h2>
              <p className="mt-1 text-xs leading-relaxed text-neutral-300">
                The <strong>{state.run.refuseAt ?? "envelope"}</strong> envelope ran out. The next step was priced at{" "}
                <strong>{refusalDetail.needed}</strong> tokens against{" "}
                <strong>{refusalDetail.headroom}</strong> token-equivalents of headroom
                {refusalDetail.headroom !== "n/a" && state.run.refuseAt !== "tokens" ? (
                  <>
                    {" "}
                    (raw token headroom was {fmtTokens(state.run.capTokens - state.run.usedTokens)}, but{" "}
                    {state.run.refuseAt} bound first)
                  </>
                ) : null}
                . No further step executed.
              </p>
            </section>
          )}

          {status === "awaiting-approval" && (
            <section className="rounded-lg border border-[#3a2f14] bg-[#241c0d] p-3 text-xs text-[var(--color-warn)]">
              Paused: {pending} budget request(s) awaiting a human decision. The run resumes the moment one is made,
              or stops as a partial result if the window closes.
            </section>
          )}

          {state && state.run.costReportJson ? (
            <section className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-3">
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-[var(--color-muted)]">
                Cost report
              </h2>
              <pre className="tabular max-h-56 overflow-auto text-[11px] leading-relaxed text-neutral-300">
                {JSON.stringify(JSON.parse(state.run.costReportJson), null, 2)}
              </pre>
            </section>
          ) : null}

          {showSettings && (
            <section className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-3">
              <Settings settings={settings} onChange={setSettings} />
            </section>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {state ? (
            <>
              <Ledger rows={state.ledger} totals={state.totals} />
              <Reconciliation recon={state.reconciliation} />
              {state.findings.length > 0 && (
                <section className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-3">
                  <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-muted)]">
                    Findings ({state.findings.length})
                  </h2>
                  <ul className="flex flex-col gap-1 text-[11px] text-neutral-300">
                    {state.findings.map((f) => (
                      <li key={f.key} className="rounded border border-[var(--color-edge)] px-2 py-1">
                        <span className="text-[var(--color-muted)]">{f.key}:</span> {f.value}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          ) : (
            <p className="rounded-lg border border-dashed border-[var(--color-edge)] p-6 text-center text-xs text-[var(--color-muted)]">
              No run loaded. Set a task and an envelope, then start a run. Deep links work too: <code>?run=&lt;id&gt;</code>.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-4">
          {state && (
            <>
              <ApprovalInbox approvals={state.approvals} onDecide={onDecide} />
              <Negotiation rows={state.negotiations} />
            </>
          )}
        </div>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-edge)] pt-2 text-[11px] text-[var(--color-muted)]">
        <span>
          Durable steps run on Inngest; the envelope lives in SQLite keyed by run id. localStorage
          key: <code>{SETTINGS_KEY}</code>.
        </span>
        <span>
          Built by{" "}
          <a
            href="https://harishkotra.me"
            target="_blank"
            rel="noreferrer"
            className="text-neutral-300 underline decoration-[var(--color-edge)] underline-offset-2 hover:text-[var(--color-accent)]"
          >
            Harish Kotra
          </a>
          {" · "}
          <a
            href="https://dailybuild.xyz"
            target="_blank"
            rel="noreferrer"
            className="text-neutral-300 underline decoration-[var(--color-edge)] underline-offset-2 hover:text-[var(--color-accent)]"
          >
            Checkout my other builds
          </a>
        </span>
      </footer>
    </div>
  );
}
