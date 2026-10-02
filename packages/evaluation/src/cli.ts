import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { writeExperimentArtifacts } from "./export.js";
import { runSeededExperiment } from "./runner.js";
import {
  evaluationSystems,
  experimentScenarios,
  type CheckpointGranularity,
  type EvaluationSystem,
  type ExperimentScenario,
} from "./types.js";
import { defaultEvaluationWorkload } from "./workload.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function listArgument<T extends string>(name: string, allowed: readonly T[], fallback: readonly T[]): T[] {
  const raw = argument(name);
  if (!raw) return [...fallback];
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  for (const value of values) {
    if (!allowed.includes(value as T)) throw new Error(`Invalid ${name} value: ${value}`);
  }
  return values as T[];
}

function integerArgument(name: string, fallback: number): number {
  const raw = argument(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function sourceRevision(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const granularities = listArgument(
  "--granularity",
  ["1", "2", "4"] as const,
  ["1"] as const,
).map((value) => Number(value) as CheckpointGranularity);
const configuration = {
  seed: integerArgument("--seed", 20_260_901),
  trials: integerArgument("--trials", 100),
  systems: listArgument<EvaluationSystem>("--systems", evaluationSystems, evaluationSystems),
  scenarios: listArgument<ExperimentScenario>("--scenarios", experimentScenarios, experimentScenarios),
  checkpointGranularities: granularities,
  workload: defaultEvaluationWorkload,
};
const output = runSeededExperiment(configuration, { sourceRevision: sourceRevision() });
const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
const outputDirectory = resolve(invocationDirectory, argument("--output") ?? `evaluation-results/${output.manifest.experimentId}`);
await writeExperimentArtifacts(outputDirectory, output);
console.log(JSON.stringify({
  experimentId: output.manifest.experimentId,
  manifestHash: output.manifest.manifestHash,
  trials: output.results.length,
  outputDirectory,
}, null, 2));
