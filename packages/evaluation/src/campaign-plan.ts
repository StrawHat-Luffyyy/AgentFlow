/** Dry-run projection and the campaign-wide cost guard (brief §3.3). Pure, so unit-testable. */
import { usageCostUsd, type ModelPrice } from "@agentflow/shared";

export interface CampaignShape {
  systems: readonly string[];
  scenarios: readonly string[];
  trials: number;
  /** Projected input + output tokens per LLM call (a planning estimate, never reported as usage). */
  tokensPerCall: number;
  /** LLM calls per fault-free run of the reference workflow. */
  callsPerRun?: number;
  /** Process restarts allowed per trial (each can repeat every call once in the worst case). */
  maxRestarts?: number;
  /** Calls rejected per trial in E8 (counted as calls, not billed). */
  e8RejectedCalls?: number;
}

export interface CampaignProjection {
  runs: number;
  expectedCalls: number;
  upperBoundCalls: number;
  expectedTokens: number;
  upperBoundTokens: number;
  expectedCostUsd: number | null;
  upperBoundCostUsd: number | null;
}

/**
 * Expected = every run makes its fault-free calls once (E8 adds the rejected retries,
 * which are not billed). Upper bound = every allowed restart repeats every call.
 */
export function projectCampaign(shape: CampaignShape, price: ModelPrice | null): CampaignProjection {
  const callsPerRun = shape.callsPerRun ?? 2;
  const maxRestarts = shape.maxRestarts ?? 3;
  const rejected = shape.e8RejectedCalls ?? 2;
  const runs = shape.systems.length * shape.scenarios.length * shape.trials;
  const e8Runs = shape.systems.length * shape.scenarios.filter((s) => s === "E8").length * shape.trials;
  const expectedBilledCalls = runs * callsPerRun;
  const upperBilledCalls = runs * callsPerRun * (1 + maxRestarts);
  const cost = (tokens: number) => price
    // Planning estimate: split tokens evenly between input and output.
    ? usageCostUsd({ inputTokens: tokens / 2, outputTokens: tokens / 2, cachedInputTokens: 0 }, price)
    : null;
  return {
    runs,
    expectedCalls: expectedBilledCalls + e8Runs * rejected,
    upperBoundCalls: upperBilledCalls + e8Runs * rejected,
    expectedTokens: expectedBilledCalls * shape.tokensPerCall,
    upperBoundTokens: upperBilledCalls * shape.tokensPerCall,
    expectedCostUsd: cost(expectedBilledCalls * shape.tokensPerCall),
    upperBoundCostUsd: cost(upperBilledCalls * shape.tokensPerCall),
  };
}

/** True when the campaign must stop before starting another trial. */
export function costGuardTripped(spentTokens: number, maxCampaignTokens: number | null): boolean {
  return maxCampaignTokens !== null && spentTokens >= maxCampaignTokens;
}

export function renderProjection(shape: CampaignShape, projection: CampaignProjection, label: string): string {
  const money = (value: number | null) => (value === null ? "n/a (no configured price)" : `$${value.toFixed(4)}`);
  return [
    `Dry run: ${label}`,
    `  systems   ${shape.systems.join(", ")}`,
    `  scenarios ${shape.scenarios.join(", ")}`,
    `  trials    ${shape.trials} per condition -> ${projection.runs} runs`,
    `  LLM calls expected ${projection.expectedCalls}, upper bound ${projection.upperBoundCalls}`,
    `  tokens    expected ${projection.expectedTokens}, upper bound ${projection.upperBoundTokens} (at ${shape.tokensPerCall} per call, an estimate)`,
    `  cost      expected ${money(projection.expectedCostUsd)}, upper bound ${money(projection.upperBoundCostUsd)}`,
    "Nothing was started and nothing was spent.",
  ].join("\n");
}
