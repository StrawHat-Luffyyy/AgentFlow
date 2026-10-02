import { cloudComparisonCorpusHash } from "@agentflow/research";
import type { EvaluationWorkload, ExperimentCondition, ExperimentScenario } from "./types.js";

export const defaultEvaluationWorkload: EvaluationWorkload = {
  id: "cloud-comparison-evaluation",
  version: "1.0.0",
  corpusHash: cloudComparisonCorpusHash,
  operations: [
    { id: "search-aws", kind: "READ", latencyMs: 8, payloadBytes: 2_048 },
    { id: "search-azure", kind: "READ", latencyMs: 8, payloadBytes: 2_048 },
    { id: "search-gcp", kind: "READ", latencyMs: 8, payloadBytes: 2_048 },
    { id: "collect-sources", kind: "READ", latencyMs: 3, payloadBytes: 6_144 },
    { id: "analyze-pricing", kind: "LLM", latencyMs: 25, inputTokens: 480, outputTokens: 120, payloadBytes: 1_024 },
    { id: "analyze-features", kind: "LLM", latencyMs: 25, inputTokens: 520, outputTokens: 140, payloadBytes: 1_024 },
    { id: "generate-report", kind: "LLM", latencyMs: 35, inputTokens: 900, outputTokens: 360, payloadBytes: 4_096 },
    { id: "approve-publication", kind: "APPROVAL", latencyMs: 2, payloadBytes: 256 },
    { id: "publish-report", kind: "WRITE", latencyMs: 10, payloadBytes: 4_096 },
  ],
};

const defaultCondition = {
  receiverSupportsIdempotency: true,
  recoveryDelayMs: 20,
  maxRestarts: 3,
  maxAttempts: 3,
} as const;

export function conditionForScenario(scenario: ExperimentScenario): ExperimentCondition {
  const conditions: Record<ExperimentScenario, ExperimentCondition> = {
    E0: { scenario, faults: [], ...defaultCondition },
    E1: {
      scenario,
      faults: [{ id: "e1-late-crash", hook: "after-checkpoint-commit", action: "crash", operationId: "collect-sources", occurrence: 1 }],
      ...defaultCondition,
    },
    E2: {
      scenario,
      faults: [{ id: "e2-lost-inference", hook: "after-provider-response", action: "crash", operationId: "analyze-features", occurrence: 1 }],
      ...defaultCondition,
    },
    E3: {
      scenario,
      faults: [{ id: "e3-provider-503", hook: "before-operation", action: "transient-error", operationId: "analyze-pricing", occurrence: 1, repeat: 2 }],
      ...defaultCondition,
    },
    E4: {
      scenario,
      faults: [{ id: "e4-read-timeout", hook: "before-operation", action: "timeout", operationId: "search-azure", occurrence: 1 }],
      ...defaultCondition,
    },
    E5: {
      scenario,
      faults: [{ id: "e5-effect-committed", hook: "after-receiver-commit", action: "crash", operationId: "publish-report", occurrence: 1 }],
      ...defaultCondition,
    },
    E6: {
      scenario,
      faults: [{ id: "e6-unsupported-effect", hook: "after-receiver-commit", action: "crash", operationId: "publish-report", occurrence: 1 }],
      ...defaultCondition,
      receiverSupportsIdempotency: false,
    },
    E7: {
      scenario,
      faults: [{ id: "e7-approval-restart", hook: "after-approval-decision", action: "crash", operationId: "approve-publication", occurrence: 1 }],
      ...defaultCondition,
    },
  };
  return structuredClone(conditions[scenario]);
}
