import { DeterministicFaultController, InjectedFault } from "./faults.js";
import { SeededRandom, hashSeed } from "./random.js";
import type {
  CheckpointGranularity,
  EvaluationOperation,
  EvaluationSystem,
  EvaluationWorkload,
  ExperimentCondition,
  TrialMetrics,
} from "./types.js";

interface SystemCapabilities {
  durableCheckpoints: boolean;
  stableReceiverKey: boolean;
  receiverAware: boolean;
}

const capabilities: Record<EvaluationSystem, SystemCapabilities> = {
  B0: { durableCheckpoints: false, stableReceiverKey: false, receiverAware: false },
  B1: { durableCheckpoints: false, stableReceiverKey: true, receiverAware: false },
  A0: { durableCheckpoints: true, stableReceiverKey: false, receiverAware: false },
  A1: { durableCheckpoints: true, stableReceiverKey: true, receiverAware: true },
};

function isMandatoryBoundary(operation: EvaluationOperation): boolean {
  return operation.kind === "APPROVAL" || operation.kind === "WRITE";
}

function shouldCheckpoint(
  operation: EvaluationOperation,
  bufferedOperations: number,
  granularity: CheckpointGranularity,
  isLast: boolean,
): boolean {
  return isMandatoryBoundary(operation) || bufferedOperations >= granularity || isLast;
}

export function runSystemTrial(input: {
  seed: number;
  trialIndex: number;
  system: EvaluationSystem;
  condition: ExperimentCondition;
  granularity: CheckpointGranularity;
  workload: EvaluationWorkload;
}): TrialMetrics {
  const random = new SeededRandom(`${input.seed}:${input.trialIndex}:${input.system}:${input.condition.scenario}:${input.granularity}`);
  const controller = new DeterministicFaultController(input.condition.faults);
  const system = capabilities[input.system];
  const calls = new Map<string, number>();
  const llmCalls = new Map<string, number>();
  const acceptedReceiverKeys = new Set<string>();
  const durableApprovals = new Set<string>();
  let durableCursor = 0;
  let cursor = 0;
  let buffered = 0;
  let bufferedBytes = 0;
  let restarts = 0;
  let elapsedMs = 0;
  let recoveryMs = 0;
  let receiverEffects = 0;
  let approvalDecisions = 0;
  let checkpoints = 0;
  let checkpointBytes = 0;
  const checkpointLatencyMs: number[] = [];
  let outcome: TrialMetrics["outcome"] = "FAILED";

  run: while (true) {
    if (cursor >= input.workload.operations.length) {
      outcome = "SUCCEEDED";
      break;
    }
    const operation = input.workload.operations[cursor]!;
    const priorCalls = calls.get(operation.id) ?? 0;
    calls.set(operation.id, priorCalls + 1);
    if (operation.kind === "LLM") {
      llmCalls.set(operation.id, (llmCalls.get(operation.id) ?? 0) + 1);
    }

    let attempt = 0;
    while (attempt < input.condition.maxAttempts) {
      attempt += 1;
      try {
        controller.hit("before-operation", operation.id, elapsedMs);
        elapsedMs += operation.latencyMs;

        if (operation.kind === "LLM") {
          controller.hit("after-provider-response", operation.id, elapsedMs);
        }

        if (operation.kind === "APPROVAL") {
          if (!system.durableCheckpoints || !durableApprovals.has(operation.id)) {
            approvalDecisions += 1;
            if (system.durableCheckpoints) {
              durableApprovals.add(operation.id);
              durableCursor = Math.max(durableCursor, cursor + 1);
            }
          }
          controller.hit("approval-waiting", operation.id, elapsedMs);
          controller.hit("after-approval-decision", operation.id, elapsedMs);
        }

        if (operation.kind === "WRITE") {
          const receiverKey = `${input.trialIndex}:${operation.id}`;
          const mayDeduplicate = system.stableReceiverKey && input.condition.receiverSupportsIdempotency;
          if (!mayDeduplicate || !acceptedReceiverKeys.has(receiverKey)) {
            receiverEffects += 1;
            if (mayDeduplicate) acceptedReceiverKeys.add(receiverKey);
          }
          try {
            controller.hit("after-receiver-commit", operation.id, elapsedMs);
          } catch (error) {
            if (
              error instanceof InjectedFault && error.action === "crash" &&
              system.receiverAware && !input.condition.receiverSupportsIdempotency
            ) {
              outcome = "UNKNOWN";
              break run;
            }
            throw error;
          }
        }

        buffered += 1;
        bufferedBytes += operation.payloadBytes ?? 0;
        const atBoundary = shouldCheckpoint(
          operation,
          buffered,
          input.granularity,
          cursor === input.workload.operations.length - 1,
        );
        if (atBoundary) {
          controller.hit("before-checkpoint-commit", operation.id, elapsedMs);
          if (system.durableCheckpoints) {
            const latency = 2 + random.integer(0, 2);
            elapsedMs += latency;
            checkpointLatencyMs.push(latency);
            checkpoints += 1;
            checkpointBytes += 128 + bufferedBytes;
            durableCursor = cursor + 1;
          }
          buffered = 0;
          bufferedBytes = 0;
          controller.hit("after-checkpoint-commit", operation.id, elapsedMs);
        }
        cursor += 1;
        continue run;
      } catch (error) {
        if (!(error instanceof InjectedFault)) throw error;
        if (error.action === "permanent-error") {
          outcome = "FAILED";
          break run;
        }
        if (error.action === "transient-error" || error.action === "timeout" || error.action === "database-outage") {
          if (attempt >= input.condition.maxAttempts) {
            outcome = "FAILED";
            break run;
          }
          elapsedMs += attempt * 5;
          calls.set(operation.id, (calls.get(operation.id) ?? 0) + 1);
          if (operation.kind === "LLM") {
            llmCalls.set(operation.id, (llmCalls.get(operation.id) ?? 0) + 1);
          }
          continue;
        }

        restarts += 1;
        if (restarts > input.condition.maxRestarts) {
          outcome = "FAILED";
          break run;
        }
        elapsedMs += input.condition.recoveryDelayMs;
        recoveryMs += input.condition.recoveryDelayMs;
        cursor = system.durableCheckpoints ? durableCursor : 0;
        buffered = 0;
        bufferedBytes = 0;
        continue run;
      }
    }
  }

  const physicalOperations = [...calls.values()].reduce((sum, count) => sum + count, 0);
  const logicalOperationsCalled = calls.size;
  const llmCallCount = [...llmCalls.values()].reduce((sum, count) => sum + count, 0);
  const logicalLlmCalls = llmCalls.size;
  const inputTokens = input.workload.operations.reduce((sum, operation) => {
    return sum + (operation.inputTokens ?? 0) * (llmCalls.get(operation.id) ?? 0);
  }, 0);
  const outputTokens = input.workload.operations.reduce((sum, operation) => {
    return sum + (operation.outputTokens ?? 0) * (llmCalls.get(operation.id) ?? 0);
  }, 0);
  const intendedWrites = input.workload.operations.filter((operation) => operation.kind === "WRITE").length;
  const duplicateEffects = Math.max(0, receiverEffects - intendedWrites);
  const trialSeed = hashSeed(`${input.seed}:${input.trialIndex}`);

  return {
    schemaVersion: "1.0.0",
    trialId: `${input.condition.scenario}-g${input.granularity}-${input.trialIndex}-${trialSeed.toString(16).padStart(8, "0")}`,
    seed: trialSeed,
    system: input.system,
    scenario: input.condition.scenario,
    checkpointGranularity: input.granularity,
    outcome,
    elapsedMs,
    recoveryMs: recoveryMs === 0 ? null : recoveryMs,
    restarts,
    physicalOperations,
    repeatedOperations: physicalOperations - logicalOperationsCalled,
    reexecutedCommittedOperations: 0,
    llmCalls: llmCallCount,
    repeatedLlmCalls: llmCallCount - logicalLlmCalls,
    inputTokens,
    outputTokens,
    checkpoints,
    checkpointBytes,
    checkpointLatencyMs,
    receiverEffects,
    duplicateEffects,
    missingEffects: receiverEffects === 0 && intendedWrites > 0 ? intendedWrites : 0,
    unknownOutcomes: outcome === "UNKNOWN" ? 1 : 0,
    approvalDecisions,
    invalidApprovalExecutions: 0,
    faults: controller.events,
  };
}
