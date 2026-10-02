import { SeededRandom } from "./random.js";
import { createExperimentManifest } from "./manifest.js";
import { runSystemTrial } from "./systems.js";
import { conditionForScenario } from "./workload.js";
import type { ExperimentOutput, RunnerConfiguration } from "./types.js";

export function runSeededExperiment(
  configuration: RunnerConfiguration,
  options: { createdAt?: string; sourceRevision?: string } = {},
): ExperimentOutput {
  if (!Number.isInteger(configuration.seed)) throw new Error("Experiment seed must be an integer");
  if (!Number.isInteger(configuration.trials) || configuration.trials < 1) {
    throw new Error("Experiment trials must be a positive integer");
  }
  const results: ExperimentOutput["results"] = [];
  const orderRandom = new SeededRandom(configuration.seed);

  for (const granularity of configuration.checkpointGranularities) {
    for (const scenario of configuration.scenarios) {
      const condition = conditionForScenario(scenario);
      for (let trialIndex = 0; trialIndex < configuration.trials; trialIndex += 1) {
        const systemOrder = orderRandom.shuffle(configuration.systems);
        for (const system of systemOrder) {
          results.push(runSystemTrial({
            seed: configuration.seed,
            trialIndex,
            system,
            condition,
            granularity,
            workload: configuration.workload,
          }));
        }
      }
    }
  }
  return {
    manifest: createExperimentManifest(configuration, options),
    results,
  };
}
