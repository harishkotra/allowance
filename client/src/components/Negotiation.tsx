import type { NegotiationRow } from "../../../shared/types";
import { fmtTime, fmtTokens, fmtUsd } from "../lib/api";

function parse(payload: string): Record<string, unknown> {
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return { text: payload };
  }
}

const ACTOR_STYLE: Record<string, string> = {
  agent: "text-[var(--color-accent)]",
  human: "text-[var(--color-ok)]",
  system: "text-[var(--color-warn)]",
};

function Line({ row }: { row: NegotiationRow }) {
  const data = parse(row.payload);
  let body = "";

  switch (row.kind) {
    case "agent-request":
      body = `asked for ${fmtTokens(Number(data.wantTokens ?? 0))} tokens / ${fmtUsd(Number(data.wantUsd ?? 0))} / ${Math.round(Number(data.wantSeconds ?? 0))}s — ${String(data.justification ?? "")} (tier ${String(data.tier)}, ${String(data.status)})`;
      break;
    case "human-decision":
      body = `decision: ${String(data.decision ?? "?")}` +
        (data.newCaps
          ? ` → new caps ${fmtTokens(Number((data.newCaps as { capTokens: number }).capTokens))} tok, ${fmtUsd(
              Number((data.newCaps as { capUsd: number }).capUsd),
            )}`
          : "");
      break;
    case "auto-decision":
      body = `auto-approved: ${String(data.decision ?? "")} (${String(data.why ?? "")})`;
      break;
    case "agent-next-action":
      body = String(data.notice ?? "");
      break;
    case "replan":
      body = `re-planned ${String(data.fromSteps)} → ${String(data.toSteps)} step(s) to fit ${fmtTokens(
        Number(data.remaining ?? 0),
      )} remaining tokens`;
      break;
    case "refusal":
      body = `${String(data.message ?? "REFUSED")} needed ${fmtTokens(Number(data.neededTokens ?? 0))}, headroom ${fmtTokens(
        Number(data.remainingTokenEquivalent ?? 0),
      )}`;
      break;
    default:
      body = String(data.notice ?? JSON.stringify(data)).slice(0, 240);
  }

  const emphasis =
    row.kind === "refusal"
      ? "border-l-2 border-[var(--color-bad)] pl-2"
      : row.kind === "agent-request"
        ? "border-l-2 border-[var(--color-accent)] pl-2"
        : row.kind === "human-decision"
          ? "border-l-2 border-[var(--color-ok)] pl-2"
          : "";

  return (
    <li className={`text-[11px] leading-relaxed ${emphasis}`}>
      <span className="tabular text-[var(--color-muted)]">{fmtTime(row.createdAt)}</span>{" "}
      <span className={`font-semibold ${ACTOR_STYLE[row.actor] ?? "text-neutral-300"}`}>{row.actor}</span>{" "}
      <span className="text-[var(--color-muted)]">{row.kind}</span>{" "}
      <span className="text-neutral-300">{body}</span>
    </li>
  );
}

export default function Negotiation({ rows }: { rows: NegotiationRow[] }) {
  return (
    <section aria-label="Negotiation transcript">
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-muted)]">Negotiation</h2>
        <span className="text-xs text-[var(--color-muted)]">{rows.length} entries</span>
      </header>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--color-edge)] px-3 py-4 text-xs text-[var(--color-muted)]">
          Nothing filed yet. The agent raises a request when envelope pressure crosses 60%.
        </p>
      ) : (
        <ol className="flex flex-col gap-2 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-3">
          {rows.map((row) => (
            <Line key={row.seq} row={row} />
          ))}
        </ol>
      )}
    </section>
  );
}
