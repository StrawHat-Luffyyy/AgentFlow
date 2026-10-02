export const evaluationSystems = ["B0", "B1", "A0", "A1"] as const;
export type EvaluationSystem = (typeof evaluationSystems)[number];

export const experimentScenarios = ["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"] as const;
export type ExperimentScenario = (typeof experimentScenarios)[number];

export type OperationKind = "READ" | "LLM" | "APPROVAL" | "WRITE";
export type CheckpointGranularity = 1 | 2 | 4;

export interface EvaluationOperation {
  id: string;
  kind: OperationKind;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  payloadBytes?: number;
}

export interface EvaluationWorkload {
  id: string;
  version: string;
  corpusHash: string;
  operations: EvaluationOperation[];
}

export const faultHookPoints = [
  "before-operation",
  "after-provider-response",
  "after-receiver-commit",
  "before-checkpoint-commit",
  "after-checkpoint-commit",
  "approval-waiting",
  "after-approval-decision",
] as const;
export type FaultHookPoint = (typeof faultHookPoints)[number];

export const faultActions = [
  "crash",
  "transient-error",
  "timeout",
  "database-outage",
  "permanent-error",
] as const;
export type FaultAction = (typeof faultActions)[number];

export interface FaultSpec {
  id: string;
  hook: FaultHookPoint;
  action: FaultAction;
  operationId: string;
  occurrence: number;
  repeat?: number;
}

export interface ExperimentCondition {
  scenario: ExperimentScenario;
  faults: FaultSpec[];
  receiverSupportsIdempotency: boolean;
  recoveryDelayMs: number;
  maxRestarts: number;
  maxAttempts: number;
}

export type TrialOutcome = "SUCCEEDED" | "FAILED" | "UNKNOWN";

export interface FaultEvent {
  faultId: string;
  hook: FaultHookPoint;
  action: FaultAction;
  operationId: string;
  occurrence: number;
  elapsedMs: number;
}

export interface TrialMetrics {
  schemaVersion: "1.0.0";
  trialId: string;
  seed: number;
  system: EvaluationSystem;
  scenario: ExperimentScenario;
  checkpointGranularity: CheckpointGranularity;
  outcome: TrialOutcome;
  elapsedMs: number;
  recoveryMs: number | null;
  restarts: number;
  physicalOperations: number;
  repeatedOperations: number;
  reexecutedCommittedOperations: number;
  llmCalls: number;
  repeatedLlmCalls: number;
  inputTokens: number;
  outputTokens: number;
  checkpoints: number;
  checkpointBytes: number;
  checkpointLatencyMs: number[];
  receiverEffects: number;
  duplicateEffects: number;
  missingEffects: number;
  unknownOutcomes: number;
  approvalDecisions: number;
  invalidApprovalExecutions: number;
  faults: FaultEvent[];
}

export interface RunnerConfiguration {
  seed: number;
  trials: number;
  systems: EvaluationSystem[];
  scenarios: ExperimentScenario[];
  checkpointGranularities: CheckpointGranularity[];
  workload: EvaluationWorkload;
}

export interface ExperimentManifest {
  schemaVersion: "1.0.0";
  experimentId: string;
  createdAt: string;
  seed: number;
  trials: number;
  randomizedSystemOrder: true;
  systems: EvaluationSystem[];
  scenarios: ExperimentScenario[];
  checkpointGranularities: CheckpointGranularity[];
  workload: {
    id: string;
    version: string;
    corpusHash: string;
    operationCount: number;
    digest: string;
  };
  implementation: {
    agentFlowVersion: string;
    sourceRevision: string;
    node: string;
    platform: string;
    architecture: string;
    cpus: number;
    cpuModel: string;
    totalMemoryBytes: number;
  };
  policy: {
    maxAttempts: number;
    maxRestarts: number;
    recoveryDelayMs: number;
  };
  reference: {
    system: "DBOS";
    package: "@dbos-inc/dbos-sdk";
    version: "5.2.11";
    subset: string;
  };
  conditions: Partial<Record<ExperimentScenario, ExperimentCondition>>;
  manifestHash: string;
}

export interface ExperimentOutput {
  manifest: ExperimentManifest;
  results: TrialMetrics[];
}
