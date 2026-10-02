import { createHash } from "node:crypto";
import { cpus, platform, arch, totalmem } from "node:os";
import { canonicalJson } from "@agentflow/shared";
import { conditionForScenario } from "./workload.js";
import type { ExperimentManifest, RunnerConfiguration } from "./types.js";

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createExperimentManifest(
  configuration: RunnerConfiguration,
  options: { createdAt?: string; sourceRevision?: string } = {},
): ExperimentManifest {
  const cpuList = cpus();
  const workloadDigest = digest(configuration.workload);
  const conditions = Object.fromEntries(
    configuration.scenarios.map((scenario) => [scenario, conditionForScenario(scenario)]),
  ) as ExperimentManifest["conditions"];
  const configurationDigest = digest({
    seed: configuration.seed,
    trials: configuration.trials,
    systems: configuration.systems,
    scenarios: configuration.scenarios,
    checkpointGranularities: configuration.checkpointGranularities,
    workload: configuration.workload,
    conditions,
    reference: { package: "@dbos-inc/dbos-sdk", version: "5.2.11" },
  });
  const base = {
    schemaVersion: "1.0.0" as const,
    experimentId: `agentflow-eval-${configuration.seed}-${configurationDigest.slice(0, 12)}`,
    createdAt: options.createdAt ?? new Date().toISOString(),
    seed: configuration.seed,
    trials: configuration.trials,
    randomizedSystemOrder: true as const,
    systems: configuration.systems,
    scenarios: configuration.scenarios,
    checkpointGranularities: configuration.checkpointGranularities,
    workload: {
      id: configuration.workload.id,
      version: configuration.workload.version,
      corpusHash: configuration.workload.corpusHash,
      operationCount: configuration.workload.operations.length,
      digest: workloadDigest,
    },
    implementation: {
      agentFlowVersion: "0.1.0",
      sourceRevision: options.sourceRevision ?? "unknown",
      node: process.version,
      platform: platform(),
      architecture: arch(),
      cpus: cpuList.length,
      cpuModel: cpuList[0]?.model ?? "unknown",
      totalMemoryBytes: totalmem(),
    },
    policy: {
      maxAttempts: 3,
      maxRestarts: 3,
      recoveryDelayMs: 20,
    },
    reference: {
      system: "DBOS" as const,
      package: "@dbos-inc/dbos-sdk" as const,
      version: "5.2.11" as const,
      subset: "sequential deterministic JSON operations with one DBOS step per AgentFlow operation",
    },
    conditions,
  };
  return { ...base, manifestHash: digest(base) };
}
