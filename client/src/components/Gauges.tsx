import { fmtPct, fmtTokens, fmtUsd } from "../lib/api";

interface GaugeProps {
  label: string;
  used: number;
  cap: number;
  pct: number;
  format: (value: number) => string;
}

function ringColor(pct: number): string {
  if (pct >= 100) return "var(--color-bad)";
  if (pct >= 80) return "var(--color-warn)";
  if (pct >= 60) return "var(--color-accent)";
  return "var(--color-ok)";
}

function Ring({ label, used, cap, pct, format }: GaugeProps) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, pct));
  const dash = (clamped / 100) * circumference;
  const color = ringColor(pct);

  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] px-3 py-3">
      <svg width="104" height="104" viewBox="0 0 104 104" role="img" aria-label={`${label} ${fmtPct(pct)} used`}>
        <circle cx="52" cy="52" r={radius} fill="none" stroke="#1c232c" strokeWidth="9" />
        <circle
          cx="52"
          cy="52"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          transform="rotate(-90 52 52)"
        />
        <text x="52" y="49" textAnchor="middle" className="tabular" fill="#e5e9f0" fontSize="16" fontWeight="600">
          {fmtPct(pct)}
        </text>
        <text x="52" y="66" textAnchor="middle" fill="var(--color-muted)" fontSize="10">
          of cap
        </text>
      </svg>
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">{label}</div>
      <div className="tabular text-xs text-neutral-300">
        {format(used)} <span className="text-[var(--color-muted)]">/ {format(cap)}</span>
      </div>
    </div>
  );
}

export default function Gauges({
  gauges,
  status,
}: {
  gauges: {
    tokens: { used: number; cap: number; pct: number };
    usd: { used: number; cap: number; pct: number };
    seconds: { used: number; cap: number; pct: number };
  };
  status: string;
}) {
  return (
    <section aria-label="Envelope gauges">
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-muted)]">Envelope</h2>
        <span className="text-xs text-[var(--color-muted)]">state: {status}</span>
      </header>
      <div className="grid grid-cols-3 gap-2">
        <Ring label="tokens" {...gauges.tokens} format={fmtTokens} />
        <Ring label="dollars" {...gauges.usd} format={fmtUsd} />
        <Ring label="seconds" {...gauges.seconds} format={(v) => `${Math.round(v)}s`} />
      </div>
    </section>
  );
}
