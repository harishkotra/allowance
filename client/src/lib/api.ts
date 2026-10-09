import type { ClientSettings, RunState } from "../../../shared/types";

export const SETTINGS_KEY = "allowance.settings.v1";

export const PRESETS: Record<string, { label: string; baseUrl: string; model: string }> = {
  particle: { label: "Particle.ai", baseUrl: "https://api.particle.ai/v1", model: "deepseek-v4.1-flash" },
  lmstudio: { label: "LM Studio", baseUrl: "http://localhost:1234/v1", model: "" },
  ollama: { label: "Ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.2" },
  gemini: {
    label: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-2.5-flash",
  },
  custom: { label: "Custom", baseUrl: "", model: "" },
};

export const DEFAULT_SETTINGS: ClientSettings = {
  preset: "particle",
  baseUrl: PRESETS.particle.baseUrl,
  model: PRESETS.particle.model,
  capTokens: 40_000,
  capUsd: 0.25,
  capSeconds: 90,
  autoApproveUnderUsd: 0.05,
  negotiate: true,
  per1kInput: 0.00015,
  per1kOutput: 0.0006,
};

export function loadSettings(): ClientSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<ClientSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: ClientSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T);
  if (!response.ok) {
    const message = (parsed as { error?: string })?.error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return parsed;
}

export async function startRun(task: string, settings: ClientSettings): Promise<{ runId: string }> {
  return json(
    await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task, settings }),
    }),
  );
}

export async function fetchState(runId: string): Promise<RunState> {
  return json(await fetch(`/api/runs/${runId}`));
}

export async function decide(approvalId: number, decision: "approve" | "deny", note: string) {
  return json(
    await fetch(`/api/approvals/${approvalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, note }),
    }),
  );
}

export async function saveApiKey(apiKey: string) {
  return json(await fetch("/api/settings/key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  }));
}

export async function testConnection(settings: ClientSettings) {
  return json(
    await fetch("/api/test-connection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings }),
    }),
  );
}

export async function fetchDefaults(): Promise<Record<string, unknown>> {
  return json(await fetch("/api/defaults"));
}

export async function fetchRuns(): Promise<
  { runId: string; task: string; status: string; usedTokens: number; capTokens: number; startedAt: string }[]
> {
  return json(await fetch("/api/runs"));
}

/**
 * Live updates arrive as full snapshots recomputed from SQLite, so the client
 * never maintains its own running total.
 */
export function subscribeToRun(runId: string, onState: (state: RunState) => void, onEnd: (status: string) => void) {
  const source = new EventSource(`/api/runs/${runId}/stream`);
  source.addEventListener("state", (event) => {
    try {
      onState(JSON.parse((event as MessageEvent).data) as RunState);
    } catch {
      /* ignore malformed frame */
    }
  });
  source.addEventListener("end", (event) => {
    try {
      onEnd(JSON.parse((event as MessageEvent).data).status);
    } catch {
      onEnd("ended");
    }
    source.close();
  });
  source.addEventListener("error", () => {
    // EventSource retries on its own; a closed stream surfaces via "end".
  });
  return () => source.close();
}

export const fmtUsd = (value: number): string =>
  value >= 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(6)}`;

export const fmtTokens = (value: number): string => Math.round(value).toLocaleString("en-US");

export const fmtPct = (value: number): string => `${value.toFixed(1)}%`;

export const fmtTime = (iso: string): string => iso.slice(11, 23);
