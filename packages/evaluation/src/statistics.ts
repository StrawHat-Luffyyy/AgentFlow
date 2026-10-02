import { SeededRandom } from "./random.js";
import type { TrialMetrics } from "./types.js";

export interface ConfidenceInterval {
  estimate: number;
  lower: number;
  upper: number;
  confidence: 0.95;
}

export function quantile(values: readonly number[], probability: number): number | null {
  if (values.length === 0) return null;
  if (probability < 0 || probability > 1) throw new Error("Probability must be between zero and one");
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function wilsonInterval(successes: number, total: number): ConfidenceInterval | null {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || successes < 0 || total <= 0 || successes > total) {
    return null;
  }
  const z = 1.959963984540054;
  const estimate = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (estimate + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((estimate * (1 - estimate) + (z * z) / (4 * total)) / total) / denominator;
  return { estimate, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), confidence: 0.95 };
}

export function pairedBootstrapInterval(
  pairs: readonly { baseline: number; treatment: number }[],
  seed: number,
  resamples = 10_000,
): ConfidenceInterval | null {
  if (pairs.length === 0 || resamples < 100) return null;
  const random = new SeededRandom(seed);
  const differences: number[] = [];
  for (let sample = 0; sample < resamples; sample += 1) {
    let total = 0;
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[random.integer(0, pairs.length - 1)]!;
      total += pair.treatment - pair.baseline;
    }
    differences.push(total / pairs.length);
  }
  const observed = pairs.reduce((sum, pair) => sum + pair.treatment - pair.baseline, 0) / pairs.length;
  return {
    estimate: observed,
    lower: quantile(differences, 0.025)!,
    upper: quantile(differences, 0.975)!,
    confidence: 0.95,
  };
}

export interface ResultSummary {
  system: string;
  scenario: string;
  checkpointGranularity: number;
  trials: number;
  completion: ConfidenceInterval | null;
  duplicateFree: ConfidenceInterval | null;
  medianElapsedMs: number | null;
  p95ElapsedMs: number | null;
  medianRepeatedOperations: number | null;
  p95CheckpointMs: number | null;
  duplicateEffects: number;
  unknownOutcomes: number;
}

export function summarizeResults(results: readonly TrialMetrics[]): ResultSummary[] {
  const groups = new Map<string, TrialMetrics[]>();
  for (const result of results) {
    const key = `${result.system}:${result.scenario}:${result.checkpointGranularity}`;
    const group = groups.get(key) ?? [];
    group.push(result);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const checkpointLatencies = group.flatMap((result) => result.checkpointLatencyMs);
    return {
      system: first.system,
      scenario: first.scenario,
      checkpointGranularity: first.checkpointGranularity,
      trials: group.length,
      completion: wilsonInterval(group.filter((result) => result.outcome === "SUCCEEDED").length, group.length),
      duplicateFree: wilsonInterval(group.filter((result) => result.duplicateEffects === 0).length, group.length),
      medianElapsedMs: quantile(group.map((result) => result.elapsedMs), 0.5),
      p95ElapsedMs: quantile(group.map((result) => result.elapsedMs), 0.95),
      medianRepeatedOperations: quantile(group.map((result) => result.repeatedOperations), 0.5),
      p95CheckpointMs: quantile(checkpointLatencies, 0.95),
      duplicateEffects: group.reduce((sum, result) => sum + result.duplicateEffects, 0),
      unknownOutcomes: group.reduce((sum, result) => sum + result.unknownOutcomes, 0),
    };
  }).sort((left, right) => {
    return left.scenario.localeCompare(right.scenario) ||
      left.system.localeCompare(right.system) ||
      left.checkpointGranularity - right.checkpointGranularity;
  });
}

export interface PairedComparison {
  baseline: TrialMetrics["system"];
  treatment: TrialMetrics["system"];
  scenario: TrialMetrics["scenario"];
  checkpointGranularity: number;
  pairs: number;
  completionDifference: ConfidenceInterval | null;
  elapsedMsDifference: ConfidenceInterval | null;
  repeatedOperationsDifference: ConfidenceInterval | null;
  llmCallsDifference: ConfidenceInterval | null;
  tokenDifference: ConfidenceInterval | null;
  duplicateEffectsDifference: ConfidenceInterval | null;
}

function metricPairs(
  baseline: readonly TrialMetrics[],
  treatment: readonly TrialMetrics[],
  metric: (result: TrialMetrics) => number,
): Array<{ baseline: number; treatment: number }> {
  const treatmentByTrial = new Map(treatment.map((result) => [result.trialId, result]));
  return baseline.flatMap((result) => {
    const match = treatmentByTrial.get(result.trialId);
    return match ? [{ baseline: metric(result), treatment: metric(match) }] : [];
  });
}

export function comparePairedResults(
  results: readonly TrialMetrics[],
  seed: number,
): PairedComparison[] {
  const comparisons: PairedComparison[] = [];
  const scenarios = [...new Set(results.map((result) => result.scenario))].sort();
  const granularities = [...new Set(results.map((result) => result.checkpointGranularity))].sort();
  for (const scenario of scenarios) {
    for (const checkpointGranularity of granularities) {
      const condition = results.filter((result) => (
        result.scenario === scenario && result.checkpointGranularity === checkpointGranularity
      ));
      const treatment = condition.filter((result) => result.system === "A1");
      for (const baselineSystem of ["B0", "B1", "A0"] as const) {
        const baseline = condition.filter((result) => result.system === baselineSystem);
        const completed = metricPairs(baseline, treatment, (result) => result.outcome === "SUCCEEDED" ? 1 : 0);
        if (completed.length === 0) continue;
        const comparisonSeed = seed ^ (scenario.charCodeAt(1) << 8) ^ checkpointGranularity ^ baselineSystem.charCodeAt(1);
        const resamples = 2_000;
        comparisons.push({
          baseline: baselineSystem,
          treatment: "A1",
          scenario,
          checkpointGranularity,
          pairs: completed.length,
          completionDifference: pairedBootstrapInterval(completed, comparisonSeed, resamples),
          elapsedMsDifference: pairedBootstrapInterval(
            metricPairs(baseline, treatment, (result) => result.elapsedMs), comparisonSeed + 1, resamples,
          ),
          repeatedOperationsDifference: pairedBootstrapInterval(
            metricPairs(baseline, treatment, (result) => result.repeatedOperations), comparisonSeed + 2, resamples,
          ),
          llmCallsDifference: pairedBootstrapInterval(
            metricPairs(baseline, treatment, (result) => result.llmCalls), comparisonSeed + 3, resamples,
          ),
          tokenDifference: pairedBootstrapInterval(
            metricPairs(baseline, treatment, (result) => result.inputTokens + result.outputTokens), comparisonSeed + 4, resamples,
          ),
          duplicateEffectsDifference: pairedBootstrapInterval(
            metricPairs(baseline, treatment, (result) => result.duplicateEffects), comparisonSeed + 5, resamples,
          ),
        });
      }
    }
  }
  return comparisons;
}

export function analyzeResults(results: readonly TrialMetrics[], seed: number): {
  groups: ResultSummary[];
  pairedComparisons: PairedComparison[];
} {
  return {
    groups: summarizeResults(results),
    pairedComparisons: comparePairedResults(results, seed),
  };
}
