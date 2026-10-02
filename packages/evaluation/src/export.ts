import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@agentflow/shared";
import { analyzeResults } from "./statistics.js";
import type { ExperimentOutput, TrialMetrics } from "./types.js";

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function resultsToCsv(results: readonly TrialMetrics[]): string {
  const columns = [
    "trialId", "seed", "system", "scenario", "checkpointGranularity", "outcome",
    "elapsedMs", "recoveryMs", "restarts", "physicalOperations", "repeatedOperations",
    "reexecutedCommittedOperations", "llmCalls", "repeatedLlmCalls", "inputTokens",
    "outputTokens", "checkpoints", "checkpointBytes", "receiverEffects", "duplicateEffects",
    "missingEffects", "unknownOutcomes", "approvalDecisions", "invalidApprovalExecutions",
  ] as const;
  const lines = [columns.join(",")];
  for (const result of results) {
    lines.push(columns.map((column) => csvCell(result[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function prometheusLabels(result: TrialMetrics): string {
  return `trial_id="${result.trialId}",system="${result.system}",scenario="${result.scenario}",checkpoint_granularity="${result.checkpointGranularity}"`;
}

export function resultsToPrometheus(results: readonly TrialMetrics[]): string {
  const lines = [
    "# HELP agentflow_evaluation_completion Trial completion (1=success).",
    "# TYPE agentflow_evaluation_completion gauge",
    "# HELP agentflow_evaluation_elapsed_milliseconds Deterministic trial elapsed time.",
    "# TYPE agentflow_evaluation_elapsed_milliseconds gauge",
    "# HELP agentflow_evaluation_repeated_operations_total Repeated physical operations in a trial.",
    "# TYPE agentflow_evaluation_repeated_operations_total gauge",
    "# HELP agentflow_evaluation_duplicate_effects_total Duplicate receiver effects in a trial.",
    "# TYPE agentflow_evaluation_duplicate_effects_total gauge",
    "# HELP agentflow_evaluation_checkpoint_bytes_total Checkpoint bytes written in a trial.",
    "# TYPE agentflow_evaluation_checkpoint_bytes_total gauge",
  ];
  for (const result of results) {
    const labels = prometheusLabels(result);
    lines.push(`agentflow_evaluation_completion{${labels}} ${result.outcome === "SUCCEEDED" ? 1 : 0}`);
    lines.push(`agentflow_evaluation_elapsed_milliseconds{${labels}} ${result.elapsedMs}`);
    lines.push(`agentflow_evaluation_repeated_operations_total{${labels}} ${result.repeatedOperations}`);
    lines.push(`agentflow_evaluation_duplicate_effects_total{${labels}} ${result.duplicateEffects}`);
    lines.push(`agentflow_evaluation_checkpoint_bytes_total{${labels}} ${result.checkpointBytes}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function writeExperimentArtifacts(outputDirectory: string, output: ExperimentOutput): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const sortedResults = [...output.results].sort((left, right) => {
    return left.trialId.localeCompare(right.trialId) || left.system.localeCompare(right.system);
  });
  await Promise.all([
    writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(output.manifest, null, 2)}\n`, "utf8"),
    writeFile(join(outputDirectory, "results.jsonl"), `${sortedResults.map((result) => canonicalJson(result)).join("\n")}\n`, "utf8"),
    writeFile(join(outputDirectory, "results.csv"), resultsToCsv(sortedResults), "utf8"),
    writeFile(join(outputDirectory, "metrics.prom"), resultsToPrometheus(sortedResults), "utf8"),
    writeFile(
      join(outputDirectory, "summary.json"),
      `${JSON.stringify(analyzeResults(sortedResults, output.manifest.seed), null, 2)}\n`,
      "utf8",
    ),
  ]);
}
