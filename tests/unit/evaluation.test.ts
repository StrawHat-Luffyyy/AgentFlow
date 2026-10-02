import {
  DeterministicFaultController,
  InjectedFault,
  conditionForScenario,
  createExperimentManifest,
  defaultEvaluationWorkload,
  pairedBootstrapInterval,
  runSeededExperiment,
  runSystemTrial,
  wilsonInterval,
} from "@agentflow/evaluation";
import { describe, expect, it } from "vitest";

describe("deterministic evaluation faults", () => {
  it("fires only at the exact configured boundary and occurrence", () => {
    const controller = new DeterministicFaultController([{
      id: "lost-response",
      hook: "after-provider-response",
      action: "crash",
      operationId: "analyze-pricing",
      occurrence: 2,
    }]);
    controller.hit("after-provider-response", "analyze-pricing", 10);
    expect(() => controller.hit("after-provider-response", "analyze-pricing", 20)).toThrow(InjectedFault);
    expect(() => controller.hit("after-provider-response", "analyze-pricing", 30)).not.toThrow();
    expect(controller.events).toEqual([expect.objectContaining({
      faultId: "lost-response",
      occurrence: 2,
      elapsedMs: 20,
    })]);
  });
});

describe("B0/B1/A0/A1 experiment systems", () => {
  const trial = (system: "B0" | "B1" | "A0" | "A1", scenario: "E1" | "E5" | "E6" | "E7", granularity: 1 | 2 | 4 = 1) => runSystemTrial({
    seed: 42,
    trialIndex: 0,
    system,
    condition: conditionForScenario(scenario),
    granularity,
    workload: defaultEvaluationWorkload,
  });

  it("preserves committed progress only in checkpointed systems", () => {
    expect(trial("B0", "E1").repeatedOperations).toBeGreaterThan(0);
    expect(trial("A1", "E1").repeatedOperations).toBe(0);
    expect(trial("A1", "E1").reexecutedCommittedOperations).toBe(0);
  });

  it("isolates stable receiver keys from checkpoint durability", () => {
    expect(trial("B0", "E5").duplicateEffects).toBe(1);
    expect(trial("A0", "E5").duplicateEffects).toBe(1);
    expect(trial("B1", "E5").duplicateEffects).toBe(0);
    expect(trial("A1", "E5").duplicateEffects).toBe(0);
  });

  it("makes unsupported ambiguous writes UNKNOWN only in receiver-aware A1", () => {
    const safe = trial("A1", "E6");
    expect(safe.outcome).toBe("UNKNOWN");
    expect(safe.unknownOutcomes).toBe(1);
    expect(safe.receiverEffects).toBe(1);
    expect(trial("A0", "E6")).toMatchObject({ outcome: "SUCCEEDED", duplicateEffects: 1 });
  });

  it("does not repeat a durable approval decision after restart", () => {
    expect(trial("B0", "E7").approvalDecisions).toBe(2);
    expect(trial("A1", "E7").approvalDecisions).toBe(1);
  });

  it("reduces checkpoint writes as repeatable operations are grouped", () => {
    const perOperation = runSystemTrial({
      seed: 7,
      trialIndex: 0,
      system: "A1",
      condition: conditionForScenario("E0"),
      granularity: 1,
      workload: defaultEvaluationWorkload,
    });
    const groupsOfFour = runSystemTrial({
      seed: 7,
      trialIndex: 0,
      system: "A1",
      condition: conditionForScenario("E0"),
      granularity: 4,
      workload: defaultEvaluationWorkload,
    });
    expect(groupsOfFour.checkpoints).toBeLessThan(perOperation.checkpoints);
    expect(groupsOfFour.approvalDecisions).toBe(1);
    expect(groupsOfFour.receiverEffects).toBe(1);
  });
});

describe("seeded runner and statistical analysis", () => {
  const configuration = {
    seed: 1234,
    trials: 3,
    systems: ["B0", "B1", "A0", "A1"] as const,
    scenarios: ["E0", "E5"] as const,
    checkpointGranularities: [1, 2] as const,
    workload: defaultEvaluationWorkload,
  };

  it("repeats the same randomized order and measurements for a seed", () => {
    const first = runSeededExperiment({
      ...configuration,
      systems: [...configuration.systems],
      scenarios: [...configuration.scenarios],
      checkpointGranularities: [...configuration.checkpointGranularities],
    }, { createdAt: "2026-10-01T00:00:00.000Z", sourceRevision: "abc123" });
    const second = runSeededExperiment({
      ...configuration,
      systems: [...configuration.systems],
      scenarios: [...configuration.scenarios],
      checkpointGranularities: [...configuration.checkpointGranularities],
    }, { createdAt: "2026-10-01T00:00:00.000Z", sourceRevision: "abc123" });
    expect(second).toEqual(first);
    expect(first.results).toHaveLength(48);
  });

  it("hashes the complete provenance manifest and retains a stable workload digest", () => {
    const base = {
      ...configuration,
      systems: [...configuration.systems],
      scenarios: [...configuration.scenarios],
      checkpointGranularities: [...configuration.checkpointGranularities],
    };
    const first = createExperimentManifest(base, { createdAt: "2026-10-01T00:00:00.000Z" });
    const second = createExperimentManifest(base, { createdAt: "2026-10-02T00:00:00.000Z" });
    expect(first.manifestHash).not.toBe(second.manifestHash);
    expect(first.workload.digest).toBe(second.workload.digest);
    expect(first.conditions.E5!.faults[0]?.hook).toBe("after-receiver-commit");
  });

  it("computes Wilson and deterministic paired bootstrap intervals", () => {
    const zeroFailures = wilsonInterval(1_000, 1_000)!;
    expect(zeroFailures.estimate).toBe(1);
    expect(zeroFailures.lower).toBeGreaterThan(0.99);
    const pairs = [
      { baseline: 10, treatment: 8 },
      { baseline: 12, treatment: 9 },
      { baseline: 11, treatment: 10 },
    ];
    expect(pairedBootstrapInterval(pairs, 99, 1_000)).toEqual(
      pairedBootstrapInterval(pairs, 99, 1_000),
    );
  });
});
