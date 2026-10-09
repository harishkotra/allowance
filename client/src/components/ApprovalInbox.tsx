import { useState } from "react";
import type { ApprovalRow } from "../../../shared/types";
import { fmtTokens, fmtUsd } from "../lib/api";

function StatusPill({ status }: { status: ApprovalRow["status"] }) {
  const colors: Record<string, string> = {
    pending: "#3b2f14:text-[var(--color-warn)]",
    approved: "#12291f:text-[var(--color-ok)]",
    "auto-approved": "#121f29:text-[var(--color-accent)]",
    denied: "#2a1416:text-[var(--color-bad)]",
    timeout: "#2a1416:text-[var(--color-bad)]",
  };
  const [bg, text] = (colors[status] ?? "#1b222b:text-neutral-300").split(":");
  return (
    <span className={`${text} rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide`} style={{ background: bg }}>
      {status}
    </span>
  );
}

export default function ApprovalInbox({
  approvals,
  onDecide,
}: {
  approvals: ApprovalRow[];
  onDecide: (id: number, decision: "approve" | "deny", note: string) => Promise<void>;
}) {
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const pending = approvals.filter((a) => a.status === "pending");
  const history = approvals.filter((a) => a.status !== "pending");

  const act = async (id: number, decision: "approve" | "deny") => {
    setBusy(id);
    try {
      await onDecide(id, decision, notes[id] ?? "");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Approval inbox">
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-muted)]">Approval inbox</h2>
        <span className="text-xs text-[var(--color-muted)]">{pending.length} waiting</span>
      </header>

      {pending.length === 0 && (
        <p className="rounded-lg border border-dashed border-[var(--color-edge)] px-3 py-4 text-xs text-[var(--color-muted)]">
          No budget requests pending.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {pending.map((a) => (
          <article key={a.id} className="rounded-lg border border-[#3a2f14] bg-[var(--color-panel)] p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-neutral-200">Request #{a.id} · step {a.step}</span>
              <StatusPill status={a.status} />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-neutral-300">{a.justification}</p>
            <dl className="tabular mt-2 grid grid-cols-3 gap-2 text-[11px]">
              <div>
                <dt className="text-[var(--color-muted)]">more tokens</dt>
                <dd>{fmtTokens(a.wantTokens)}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-muted)]">more dollars</dt>
                <dd>{fmtUsd(a.wantUsd)}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-muted)]">more time</dt>
                <dd>{Math.round(a.wantSeconds)}s</dd>
              </div>
            </dl>
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">
              estimated cost of the ask: <span className="tabular text-neutral-300">{fmtUsd(a.estCostUsd)}</span> · tier:{" "}
              {a.tier}
            </p>
            <input
              value={notes[a.id] ?? ""}
              onChange={(e) => setNotes((prev) => ({ ...prev, [a.id]: e.target.value }))}
              placeholder="note (optional)"
              className="mt-2 w-full rounded border border-[var(--color-edge)] bg-[#0e1217] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
            />
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => act(a.id, "approve")}
                disabled={busy === a.id}
                className="rounded bg-[#12291f] px-3 py-1.5 text-xs font-semibold text-[var(--color-ok)] ring-1 ring-[#1f4b39] hover:bg-[#163528] disabled:opacity-50"
              >
                Approve
              </button>
              <button
                onClick={() => act(a.id, "deny")}
                disabled={busy === a.id}
                className="rounded bg-[#2a1416] px-3 py-1.5 text-xs font-semibold text-[var(--color-bad)] ring-1 ring-[#5a2126] hover:bg-[#371a1d] disabled:opacity-50"
              >
                Deny
              </button>
            </div>
          </article>
        ))}
      </div>

      {history.length > 0 && (
        <div className="mt-3">
          <h3 className="mb-1 text-[11px] uppercase tracking-wider text-[var(--color-muted)]">Decision history</h3>
          <ul className="flex flex-col gap-1">
            {history.map((a) => (
              <li key={a.id} className="flex items-center justify-between rounded border border-[var(--color-edge)] px-2 py-1 text-[11px]">
                <span className="text-neutral-400">
                  #{a.id} step {a.step} · {fmtTokens(a.wantTokens)} tok · {fmtUsd(a.wantUsd)}
                </span>
                <span className="flex items-center gap-2">
                  {a.decidedBy && <span className="text-[var(--color-muted)]">{a.decidedBy}</span>}
                  <StatusPill status={a.status} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
