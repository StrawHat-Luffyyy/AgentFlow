/** Pure extraction of LLM token metrics from a trial's evaluation events. */

export interface EvaluationEventLike {
  event: string;
  operation: string | null;
  detail: Record<string, any>;
}

export interface LlmEventMetrics {
  llmCalls: number;
  repeatedLlmCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Input + output of every provider result, i.e. what the provider billed (or estimated). */
  billedTokens: number;
  /** Tokens of results beyond the first per operation: work paid for twice. */
  repeatedTokens: number;
  /** Provider calls that returned no result (errors), and how many of those were HTTP 429. */
  providerErrors: number;
  rateLimitedCalls: number;
  /** Provenance values actually reported by the provider, sorted (e.g. ["reported"]). */
  usageProvenance: string[];
  resolvedModels: string[];
}

export function llmEventMetrics(events: readonly EvaluationEventLike[]): LlmEventMetrics {
  const starts = events.filter((e) => e.event === "provider-start");
  const results = events.filter((e) => e.event === "provider-result");
  const errors = events.filter((e) => e.event === "provider-error");
  const tokensOf = (e: EvaluationEventLike) =>
    (e.detail.usage?.inputTokens ?? 0) + (e.detail.usage?.outputTokens ?? 0);
  const seen = new Set<string>();
  let repeatedTokens = 0;
  for (const result of results) {
    const key = result.operation ?? "";
    if (seen.has(key)) repeatedTokens += tokensOf(result);
    seen.add(key);
  }
  const inputTokens = results.reduce((sum, e) => sum + (e.detail.usage?.inputTokens ?? 0), 0);
  const outputTokens = results.reduce((sum, e) => sum + (e.detail.usage?.outputTokens ?? 0), 0);
  return {
    llmCalls: starts.length,
    repeatedLlmCalls: starts.length - new Set(starts.map((e) => e.operation)).size,
    inputTokens,
    outputTokens,
    billedTokens: inputTokens + outputTokens,
    repeatedTokens,
    providerErrors: errors.length,
    rateLimitedCalls: errors.filter((e) => e.detail.status === 429).length,
    usageProvenance: [...new Set(results.map((e) => String(e.detail.usage?.provenance ?? "unknown")))].sort(),
    resolvedModels: [...new Set(results.map((e) => e.detail.resolvedModel).filter((m): m is string => typeof m === "string"))].sort(),
  };
}
