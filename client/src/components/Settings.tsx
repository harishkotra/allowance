import { useEffect, useState } from "react";
import type { ClientSettings } from "../../../shared/types";
import { PRESETS, fetchDefaults, saveApiKey, testConnection } from "../lib/api";

interface TestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  error: string | null;
  modelsStatus: number | null;
  modelCount: number | null;
  sampleModelIds: string[];
  body: string;
  droppedJsonMode: boolean;
  contentPreview?: string;
}

function Field({
  label,
  value,
  onChange,
  step,
  type = "number",
  hint,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  type?: string;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-[var(--color-muted)]">
      <span>{label}</span>
      <input
        type={type}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="tabular rounded border border-[var(--color-edge)] bg-[#0e1217] px-2 py-1 text-xs text-neutral-200 outline-none focus:border-[var(--color-accent)]"
      />
      {hint && <span className="text-[10px] text-[var(--color-muted)]">{hint}</span>}
    </label>
  );
}

export default function Settings({
  settings,
  onChange,
}: {
  settings: ClientSettings;
  onChange: (next: ClientSettings) => void;
}) {
  const [keyDraft, setKeyDraft] = useState("");
  const [keyState, setKeyState] = useState<string>("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const set = (patch: Partial<ClientSettings>) => onChange({ ...settings, ...patch });

  useEffect(() => {
    fetchDefaults()
      .then((defaults) => setKeyState(String((defaults as { keySource?: string }).keySource ?? "unknown")))
      .catch(() => setKeyState("unknown"));
  }, []);

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const payload = await testConnection(settings);
      setResult(payload as unknown as TestResult);
    } catch (error) {
      setResult({
        ok: false,
        status: 0,
        latencyMs: 0,
        error: error instanceof Error ? error.message : String(error),
        modelsStatus: null,
        modelCount: null,
        sampleModelIds: [],
        body: "",
        droppedJsonMode: false,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section aria-label="Settings" className="flex flex-col gap-4">
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-muted)]">Inference</h2>
        <div className="grid grid-cols-2 gap-2">
          <label className="col-span-2 flex flex-col gap-1 text-[11px] text-[var(--color-muted)]">
            <span>provider preset</span>
            <select
              value={settings.preset}
              onChange={(e) => {
                const preset = PRESETS[e.target.value] ?? PRESETS.custom;
                set({
                  preset: e.target.value,
                  baseUrl: preset.baseUrl || settings.baseUrl,
                  model: preset.model || settings.model,
                });
              }}
              className="rounded border border-[var(--color-edge)] bg-[#0e1217] px-2 py-1 text-xs text-neutral-200"
            >
              {Object.entries(PRESETS).map(([id, preset]) => (
                <option key={id} value={id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-[11px] text-[var(--color-muted)]">
            <span>base URL</span>
            <input
              value={settings.baseUrl}
              onChange={(e) => set({ baseUrl: e.target.value })}
              className="rounded border border-[var(--color-edge)] bg-[#0e1217] px-2 py-1 text-xs text-neutral-200 focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-[11px] text-[var(--color-muted)]">
            <span>model</span>
            <input
              value={settings.model}
              onChange={(e) => set({ model: e.target.value })}
              className="rounded border border-[var(--color-edge)] bg-[#0e1217] px-2 py-1 text-xs text-neutral-200 focus:border-[var(--color-accent)]"
            />
          </label>
        </div>

        <div className="mt-3 flex items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-[11px] text-[var(--color-muted)]">
            <span>
              API key <span className="text-[10px]">(write-only; never returned to the browser — currently: {keyState})</span>
            </span>
            <input
              type="password"
              value={keyDraft}
              placeholder="leave blank to keep the server-side key"
              onChange={(e) => setKeyDraft(e.target.value)}
              className="rounded border border-[var(--color-edge)] bg-[#0e1217] px-2 py-1 text-xs text-neutral-200 focus:border-[var(--color-accent)]"
            />
          </label>
          <button
            onClick={async () => {
              const response = await saveApiKey(keyDraft);
              setKeyState(String((response as { masked?: string }).masked ?? "sent"));
              setKeyDraft("");
            }}
            className="rounded border border-[var(--color-edge)] px-3 py-1.5 text-xs text-neutral-300 hover:bg-[#161c24]"
          >
            Store key
          </button>
        </div>

        <button
          onClick={runTest}
          disabled={testing}
          className="mt-2 w-full rounded bg-[#14202c] px-3 py-1.5 text-xs font-semibold text-[var(--color-accent)] hover:bg-[#182635] disabled:opacity-60"
          style={{ boxShadow: "inset 0 0 0 1px #1f3547" }}
        >
          {testing ? "Testing…" : "Test connection"}
        </button>

        {result && (
          <div className="mt-2 rounded border border-[var(--color-edge)] bg-[#0e1217] p-2 text-[11px]">
            <p className={result.ok ? "text-[var(--color-ok)]" : "text-[var(--color-bad)]"}>
              {result.ok ? "reachable" : "failed"} · HTTP {result.status} · {result.latencyMs} ms
              {result.error ? ` · ${result.error}` : ""}
            </p>
            <p className="text-[var(--color-muted)]">
              /models: {result.modelsStatus ?? "n/a"} · {result.modelCount ?? 0} model(s)
              {result.sampleModelIds.length ? ` (${result.sampleModelIds.slice(0, 3).join(", ")})` : ""}
            </p>
            {result.droppedJsonMode && (
              <p className="text-[var(--color-warn)]">provider rejected response_format; retried without it</p>
            )}
            {result.contentPreview && (
              <p className="mt-1 truncate text-neutral-400">reply: {result.contentPreview}</p>
            )}
            {result.body && (
              <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all text-[10px] text-neutral-500">
                {result.body}
              </pre>
            )}
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-muted)]">Envelope</h2>
        <div className="grid grid-cols-3 gap-2">
          <Field label="cap tokens" value={settings.capTokens} onChange={(v) => set({ capTokens: v })} />
          <Field label="cap $" value={settings.capUsd} step={0.01} onChange={(v) => set({ capUsd: v })} />
          <Field label="cap seconds" value={settings.capSeconds} onChange={(v) => set({ capSeconds: v })} />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Field
            label="auto-approve under $"
            step={0.001}
            value={settings.autoApproveUnderUsd}
            onChange={(v) => set({ autoApproveUnderUsd: v })}
            hint="requests priced at or below this are granted without a human"
          />
          <label className="flex items-center gap-2 self-end text-[11px] text-[var(--color-muted)]">
            <input
              type="checkbox"
              checked={settings.negotiate}
              onChange={(e) => set({ negotiate: e.target.checked })}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            allow the agent to negotiate for more budget
          </label>
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--color-muted)]">Price table</h2>
        <div className="grid grid-cols-2 gap-2">
          <Field label="$ per 1k input" step={0.00001} value={settings.per1kInput} onChange={(v) => set({ per1kInput: v })} />
          <Field label="$ per 1k output" step={0.00001} value={settings.per1kOutput} onChange={(v) => set({ per1kOutput: v })} />
        </div>
        <p className="mt-2 rounded border border-[#3a2f14] bg-[#241c0d] px-2 py-2 text-[11px] leading-relaxed text-[var(--color-warn)]">
          These prices are user-editable and are the only thing turning tokens into dollars. Nothing here is a real
          bill: every figure derived from them — and every row the provider did not attest to — is an estimate and is
          labelled as one in the ledger and reconciliation table.
        </p>
      </div>
    </section>
  );
}
