/**
 * Token report for a real-process campaign (brief §3.4): billed tokens per successful run,
 * repeated tokens, duplicates, committed re-executions and recovery, per system and
 * scenario, with 95% bootstrap intervals and Wilson bounds. Headline sentences are
 * generated from the data and state ties and losses plainly.
 *
 * Usage: node --import tsx packages/evaluation/src/token-report.ts <campaign-dir>
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bootstrapMeanInterval, quantile, wilsonInterval, type ConfidenceInterval } from "./statistics.js";

export interface TokenTrial {
  system: string;
  scenario: string;
  outcome: string;
  billedTokens?: number;
  inputTokens: number;
  outputTokens: number;
  repeatedTokens?: number;
  repeatedLlmCalls: number;
  duplicateEffects: number;
  reexecutedCommittedOperations: number;
  recoveryMs: number[];
  journalReplays?: number;
  tokensSavedByReplay?: number;
  cacheHits?: number;
  tokensSavedByCache?: number;
  rateLimitedCalls?: number;
  usageProvenance: string | string[];
  resolvedModels?: string[];
}

export interface TokenManifest {
  campaign?: string;
  seed?: number;
  provider?: string;
  model?: string;
  context?: string;
  cacheScope?: string;
  workload?: string;
  callsPerRun?: number;
  crashTurn?: number;
}

export interface TokenRow {
  system: string;
  scenario: string;
  trials: number;
  succeeded: number;
  failureRate: ConfidenceInterval | null;
  billedPerSuccessfulRun: ConfidenceInterval | null;
  repeatedTokensPerRun: ConfidenceInterval | null;
  repeatedLlmCalls: number;
  duplicateEffects: number;
  committedReexecutions: number;
  p50RecoveryMs: number | null;
  p95RecoveryMs: number | null;
  journalReplays: number;
  tokensSavedByReplay: number;
  cacheHits: number;
  tokensSavedByCache: number;
  rateLimitedCalls: number;
}

const billedOf = (trial: TokenTrial) => trial.billedTokens ?? trial.inputTokens + trial.outputTokens;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export function summarizeTokens(trials: readonly TokenTrial[], seed = 42): TokenRow[] {
  const keys = [...new Set(trials.map((t) => `${t.scenario}\u0000${t.system}`))];
  return keys.map((key) => {
    const [scenario, system] = key.split("\u0000") as [string, string];
    const group = trials.filter((t) => t.system === system && t.scenario === scenario);
    const succeeded = group.filter((t) => t.outcome === "SUCCEEDED");
    return {
      system,
      scenario,
      trials: group.length,
      succeeded: succeeded.length,
      failureRate: wilsonInterval(group.length - succeeded.length, group.length),
      billedPerSuccessfulRun: bootstrapMeanInterval(succeeded.map(billedOf), seed),
      repeatedTokensPerRun: bootstrapMeanInterval(group.map((t) => t.repeatedTokens ?? 0), seed),
      repeatedLlmCalls: sum(group.map((t) => t.repeatedLlmCalls)),
      duplicateEffects: sum(group.map((t) => t.duplicateEffects)),
      committedReexecutions: sum(group.map((t) => t.reexecutedCommittedOperations)),
      p50RecoveryMs: quantile(group.flatMap((t) => t.recoveryMs), 0.5),
      p95RecoveryMs: quantile(group.flatMap((t) => t.recoveryMs), 0.95),
      journalReplays: sum(group.map((t) => t.journalReplays ?? 0)),
      tokensSavedByReplay: sum(group.map((t) => t.tokensSavedByReplay ?? 0)),
      cacheHits: sum(group.map((t) => t.cacheHits ?? 0)),
      tokensSavedByCache: sum(group.map((t) => t.tokensSavedByCache ?? 0)),
      rateLimitedCalls: sum(group.map((t) => t.rateLimitedCalls ?? 0)),
    };
  }).sort((a, b) => a.scenario.localeCompare(b.scenario) || a.system.localeCompare(b.system));
}

/** "reported" only when every result carried provider-reported usage; otherwise an honest label. */
export function provenanceLabel(trials: readonly TokenTrial[], manifest: TokenManifest): { label: string; billed: boolean } {
  const seen = new Set(trials.flatMap((t) => (Array.isArray(t.usageProvenance) ? t.usageProvenance : [t.usageProvenance])));
  if ((manifest.provider ?? "scripted") === "scripted" || [...seen].some((p) => p.includes("estimated"))) {
    return { label: "estimated token counts from the scripted provider, not billed usage", billed: false };
  }
  if (seen.size === 1 && seen.has("reported")) return { label: "provider-reported (billed) usage", billed: true };
  return { label: `mixed usage provenance (${[...seen].sort().join(", ")})`, billed: false };
}

const systemNames: Record<string, string> = {
  DBOS: "DBOS",
  C1: "C1 (Temporal-style)",
  "C1-step": "C1-step (Temporal-style, agent loop as one activity)",
  C2: "C2 (LangGraph-style)",
  B0: "B0 (volatile)",
  B1: "B1 (volatile, idempotent receiver)",
  "A1-nojournal": "A1 without journal replay",
  A0: "A0",
};

const fmt = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const ci = (interval: ConfidenceInterval | null) =>
  interval ? `${fmt(interval.estimate)} (95% CI ${fmt(interval.lower)}–${fmt(interval.upper)})` : "n/a";

function relation(subject: number, other: number): string {
  if (subject === other) return "tied with";
  return subject < other ? "fewer than" : "more than";
}

/** One sentence per fault scenario comparing AgentFlow A1's repeated tokens with every baseline present. */
export function headlineSentences(rows: readonly TokenRow[], trials: readonly TokenTrial[], manifest: TokenManifest): string[] {
  const { label, billed } = provenanceLabel(trials, manifest);
  const tokenWord = billed ? "billed" : "estimated";
  const where = manifest.provider && manifest.provider !== "scripted"
    ? `live ${manifest.provider}${manifest.model ? ` ${manifest.model}` : ""}`
    : "scripted provider";
  const sentences: string[] = [];
  for (const scenario of [...new Set(rows.map((r) => r.scenario))]) {
    const a1 = rows.find((r) => r.scenario === scenario && r.system === "A1");
    if (scenario === "R1") {
      const cached = rows.find((r) => r.scenario === "R1" && r.system === "A1-cache");
      if (a1 && cached) {
        sentences.push(`Over R1 (repeated identical runs), A1 with the version-scoped response cache used ${ci(cached.billedPerSuccessfulRun)} ${tokenWord} tokens per successful run versus ${ci(a1.billedPerSuccessfulRun)} for A1 with a per-run cache (${cached.cacheHits} cache hits; n=${cached.trials}; ${where}; ${label}). This saving comes from repeated work, not from fault tolerance.`);
      }
      continue;
    }
    if (!a1?.repeatedTokensPerRun) continue;
    const others = rows.filter((r) => r.scenario === scenario && r.system !== "A1" && r.system !== "A1-cache" && r.repeatedTokensPerRun);
    if (others.length === 0) continue;
    const parts = others.map((r) => `${ci(r.repeatedTokensPerRun)} for ${systemNames[r.system] ?? r.system} (${relation(a1.repeatedTokensPerRun!.estimate, r.repeatedTokensPerRun!.estimate)} it)`);
    sentences.push(`Under ${scenario}, AgentFlow A1 repeated ${ci(a1.repeatedTokensPerRun)} ${tokenWord} tokens per run versus ${parts.join(", ")} (n=${a1.trials} per system; ${where}; ${label}).`);
  }
  return sentences;
}

export function renderTokenReport(trials: readonly TokenTrial[], manifest: TokenManifest, seed = manifest.seed ?? 42): { markdown: string; rows: TokenRow[]; headlines: string[] } {
  const rows = summarizeTokens(trials, seed);
  const headlines = headlineSentences(rows, trials, manifest);
  const { label } = provenanceLabel(trials, manifest);
  const models = [...new Set(trials.flatMap((t) => t.resolvedModels ?? []))].sort();
  const pct = (interval: ConfidenceInterval | null) =>
    interval ? `${(interval.estimate * 100).toFixed(0)}% (${(interval.lower * 100).toFixed(0)}–${(interval.upper * 100).toFixed(0)}%)` : "n/a";
  const ms = (value: number | null) => (value === null ? "–" : `${Math.round(value)}`);
  const table = [
    "| Scenario | System | n | Succeeded | Failure rate (Wilson 95%) | Tokens / successful run | Repeated tokens / run | Repeated calls | Duplicates | Committed re-exec | Recovery p50 / p95 ms | Journal replays (saved) | Cache hits (saved) | 429s |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.scenario} | ${r.system} | ${r.trials} | ${r.succeeded} | ${pct(r.failureRate)} | ${ci(r.billedPerSuccessfulRun)} | ${ci(r.repeatedTokensPerRun)} | ${r.repeatedLlmCalls} | ${r.duplicateEffects} | ${r.committedReexecutions} | ${ms(r.p50RecoveryMs)} / ${ms(r.p95RecoveryMs)} | ${r.journalReplays} (${r.tokensSavedByReplay}) | ${r.cacheHits} (${r.tokensSavedByCache}) | ${r.rateLimitedCalls} |`),
  ];
  const markdown = [
    `# Token report${manifest.campaign ? `: ${manifest.campaign}` : ""}`,
    "",
    `- Provider: ${manifest.provider ?? "scripted"}${manifest.model ? ` (${manifest.model})` : ""}${models.length ? `; resolved models: ${models.join(", ")}` : ""}`,
    `- Token provenance: ${label}`,
    `- Workload: ${manifest.workload ?? "cloud-comparison"}${manifest.callsPerRun ? ` (${manifest.callsPerRun} LLM calls in one agent step${manifest.crashTurn ? `; E2/E2B crash after call ${manifest.crashTurn}` : ""})` : " (one LLM call per agent step)"}`,
    `- Context: ${manifest.context ?? "full"}; cache scope: ${manifest.cacheScope ?? "default (run)"}`,
    "- Token counts are compared within this provider only; tokenizers differ across providers.",
    "",
    "## Headline",
    "",
    ...(headlines.length ? headlines.map((h) => `- ${h}`) : ["- No scenario had both A1 and a baseline."]),
    "",
    "## Per system and scenario",
    "",
    ...table,
    "",
    "Repeated tokens are the tokens of LLM results beyond the first per LLM call (a step and its turn) in a run, i.e. work paid for again. Journal and cache savings are reported separately and are never subtracted from these figures.",
    "",
  ].join("\n");
  return { markdown, rows, headlines };
}

/** Reads a campaign directory, writes token-report.md and merges tokenSummary into summary.json. */
export async function writeTokenReport(directory: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as TokenManifest;
  const lines = (await readFile(join(directory, "results.jsonl"), "utf8")).split("\n").filter((line) => line.trim());
  const trials = lines.map((line) => JSON.parse(line) as TokenTrial);
  const { markdown, rows, headlines } = renderTokenReport(trials, manifest);
  await writeFile(join(directory, "token-report.md"), markdown);
  let summary: Record<string, unknown> = {};
  try {
    summary = JSON.parse(await readFile(join(directory, "summary.json"), "utf8")) as Record<string, unknown>;
  } catch {
    summary = {};
  }
  await writeFile(join(directory, "summary.json"), JSON.stringify({ ...summary, tokenSummary: { rows, headlines } }, null, 2));
  return headlines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: token-report.ts <campaign-dir>");
  const headlines = await writeTokenReport(resolve(directory));
  console.log(headlines.join("\n"));
  console.log(`Wrote ${join(resolve(directory), "token-report.md")}`);
}
