// Pure decision logic for starting and presenting runs. No React, DOM, or env access,
// so it can be unit-tested directly (tests/unit/web-new-run.test.ts).

export const SCRIPTED_PROVIDER = "scripted-research";

export type ParseResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

function lineColumn(text: string, position: number): { line: number; column: number } {
  const before = text.slice(0, position);
  const line = before.split("\n").length;
  return { line, column: position - before.lastIndexOf("\n") };
}

export function parseRunInput(text: string): ParseResult {
  if (text.trim() === "") return { ok: false, error: "Input is empty — enter a JSON object, e.g. {}" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reported = /line (\d+) column (\d+)/i.exec(message);
    const position = /position (\d+)/i.exec(message);
    const where = reported
      ? { line: Number(reported[1]), column: Number(reported[2]) }
      : position ? lineColumn(text, Number(position[1])) : null;
    const reason = message.replace(/\s*(in JSON )?at position \d+.*$/i, "").replace(/^JSON\.parse:\s*/i, "");
    return { ok: false, error: where ? `Invalid JSON at line ${where.line}, column ${where.column}: ${reason}` : `Invalid JSON: ${reason}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "Input must be a JSON object" };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

const DEFAULT_ASSUMPTIONS = {
  scope: "Managed Kubernetes and supporting general-purpose compute",
  geography: "Representative US region; no cross-vendor SKU equivalence asserted",
  pricing: "No live price ranking; validate current SKU, region, storage, and network costs separately",
};

export function referenceTemplate(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return JSON.stringify({
    publicationTarget: `controlled://publications/dashboard-${stamp}`,
    assumptions: DEFAULT_ASSUMPTIONS,
  }, null, 2);
}

export interface Availability {
  workers: number;
  providers: Array<{ name: string; models: string[]; workerCount: number }>;
}

export interface Readiness {
  state: "ok" | "unknown" | "warn-no-workers" | "block-missing-provider";
  message: string;
  blocking: boolean;
}

/** Advisory only: decides what the drawer shows and whether Start is enabled, never what executes. */
export function readiness(required: string[], availability: Availability | null): Readiness {
  if (availability === null) {
    return { state: "unknown", blocking: false, message: "Worker availability unknown — the run will queue until a worker picks it up" };
  }
  if (availability.workers === 0) {
    return { state: "warn-no-workers", blocking: false, message: "No workers online — the run will queue until one starts" };
  }
  const online = new Set(availability.providers.map((provider) => provider.name));
  const missing = required.find((name) => !online.has(name));
  if (missing) {
    return {
      state: "block-missing-provider",
      blocking: true,
      message: missing === "gemini"
        ? "No online worker has gemini configured — set GEMINI_API_KEY on the worker and restart it"
        : `No online worker has the ${missing} provider registered — configure it on a worker and restart it`,
    };
  }
  const plural = availability.workers === 1 ? "worker" : "workers";
  const available = required.length > 0 ? ` · ${required.join(", ")} available` : "";
  return { state: "ok", blocking: false, message: `${availability.workers} ${plural} online${available}` };
}

export type RunMode = { kind: "scripted" } | { kind: "live"; provider: string } | { kind: "none" };

export function runMode(providers: string[] | undefined): RunMode {
  const live = (providers ?? []).find((provider) => provider !== SCRIPTED_PROVIDER);
  if (live) return { kind: "live", provider: live };
  return providers?.includes(SCRIPTED_PROVIDER) ? { kind: "scripted" } : { kind: "none" };
}

export interface Report {
  title: string;
  content: string;
  citations: string[];
}

export function extractReport(steps: Array<{ acceptedOutput: unknown }>): Report | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const output = steps[index]!.acceptedOutput;
    if (typeof output !== "object" || output === null) continue;
    const report = (output as { report?: unknown }).report;
    if (typeof report !== "object" || report === null) continue;
    const { title, content, citations } = report as { title?: unknown; content?: unknown; citations?: unknown };
    if (typeof content !== "string") continue;
    return {
      title: typeof title === "string" && title.trim() ? title : "Report",
      content,
      citations: Array.isArray(citations) ? citations.filter((item): item is string => typeof item === "string") : [],
    };
  }
  return null;
}

export function deadlineMsFromMinutes(text: string): { ok: true; value: number } | { ok: false; error: string } {
  if (!/^\d+$/.test(text.trim())) return { ok: false, error: "Deadline must be a whole number of minutes" };
  const minutes = Number(text.trim());
  if (minutes < 1 || minutes > 1440) return { ok: false, error: "Deadline must be between 1 and 1440 minutes" };
  return { ok: true, value: minutes * 60_000 };
}

export interface UsageLike {
  provider: string;
  model: string;
  provenance: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface UsageSummary {
  input: number;
  output: number;
  groups: Array<{ label: string; input: number; output: number; provenances: string[] }>;
}

/**
 * Totals persisted usage records exactly as returned by the API. Null counts add nothing;
 * nothing is estimated here.
 */
export function summarizeUsage(records: UsageLike[]): UsageSummary | null {
  if (records.length === 0) return null;
  const groups = new Map<string, { input: number; output: number; provenances: Set<string> }>();
  for (const record of records) {
    const label = `${record.provider} · ${record.model}`;
    const group = groups.get(label) ?? { input: 0, output: 0, provenances: new Set<string>() };
    group.input += record.inputTokens ?? 0;
    group.output += record.outputTokens ?? 0;
    group.provenances.add(record.provenance);
    groups.set(label, group);
  }
  const list = [...groups.entries()].map(([label, group]) => ({
    label, input: group.input, output: group.output, provenances: [...group.provenances].sort(),
  }));
  return {
    input: list.reduce((sum, group) => sum + group.input, 0),
    output: list.reduce((sum, group) => sum + group.output, 0),
    groups: list,
  };
}

/** Tile/footer text for usage: persisted totals plus provenance exactly as the API returned it. */
export function usageDetail(summary: UsageSummary | null): string {
  if (summary === null) return "No usage recorded yet";
  const provenances = [...new Set(summary.groups.flatMap((group) => group.provenances))].sort();
  return `${summary.input.toLocaleString()} in · ${summary.output.toLocaleString()} out · ${provenances.join(", ")}`;
}
