import {
  AgentHarness,
  DeterministicFakeProvider,
  GroqProvider,
  ProviderRegistry,
  ToolRegistry,
  type ProviderExecutionContext,
} from "@agentflow/harness";
import { cloudComparisonWorkflowDefinition } from "@agentflow/research";
import { canonicalJson, workflowDefinitionSchema } from "@agentflow/shared";
import { describe, expect, it } from "vitest";
import { harnessOrdinal } from "../../apps/worker/src/agent.js";
import { costGuardTripped, projectCampaign } from "../../packages/evaluation/src/campaign-plan.js";
import { referenceDefinition } from "../../packages/evaluation/src/real-common.js";
import { llmEventMetrics } from "../../packages/evaluation/src/real-metrics.js";
import { bootstrapMeanInterval } from "../../packages/evaluation/src/statistics.js";
import { renderTokenReport, type TokenTrial } from "../../packages/evaluation/src/token-report.js";

const context: ProviderExecutionContext = {
  runId: "r", logicalOperationId: "o", attemptId: "a", deadlineAt: new Date(Date.now() + 60_000),
};

describe("bootstrapMeanInterval", () => {
  it("is deterministic for a seed and brackets the sample mean", () => {
    const values = [10, 12, 9, 14, 11];
    const first = bootstrapMeanInterval(values, 7)!;
    expect(bootstrapMeanInterval(values, 7)).toEqual(first);
    expect(first.estimate).toBeCloseTo(11.2, 9);
    expect(first.lower).toBeLessThanOrEqual(first.estimate);
    expect(first.upper).toBeGreaterThanOrEqual(first.estimate);
    expect(bootstrapMeanInterval([5, 5, 5], 1)).toMatchObject({ estimate: 5, lower: 5, upper: 5 });
    expect(bootstrapMeanInterval([], 1)).toBeNull();
  });
});

describe("llmEventMetrics", () => {
  const result = (operation: string, inputTokens: number, outputTokens: number, provenance = "reported") => ({
    event: "provider-result", operation, detail: { usage: { inputTokens, outputTokens, provenance }, resolvedModel: "m-1" },
  });
  const start = (operation: string) => ({ event: "provider-start", operation, detail: {} });

  it("counts tokens paid again for an operation as repeated, and 429s as unbilled calls", () => {
    const metrics = llmEventMetrics([
      start("analyze-pricing"), { event: "provider-error", operation: "analyze-pricing", detail: { status: 429 } },
      start("analyze-pricing"), result("analyze-pricing", 100, 20),
      start("analyze-features"), result("analyze-features", 90, 30),
      start("analyze-features"), result("analyze-features", 90, 31),
    ]);
    expect(metrics).toEqual({
      llmCalls: 4, repeatedLlmCalls: 2, inputTokens: 280, outputTokens: 81, billedTokens: 361,
      repeatedTokens: 121, providerErrors: 1, rateLimitedCalls: 1,
      usageProvenance: ["reported"], resolvedModels: ["m-1"],
    });
  });
});

describe("campaign cost guard and dry run", () => {
  it("projects expected and worst-case calls, tokens and cost", () => {
    const projection = projectCampaign(
      { systems: ["A1", "DBOS"], scenarios: ["E2B", "E8"], trials: 3, tokensPerCall: 1_000, e8RejectedCalls: 2 },
      { inputPer1M: 1, outputPer1M: 3 },
    );
    // 12 runs × 2 billed calls; E8 adds 2 rejected calls for each of 6 runs; worst case ×(1+3 restarts).
    expect(projection).toMatchObject({ runs: 12, expectedCalls: 36, upperBoundCalls: 108, expectedTokens: 24_000, upperBoundTokens: 96_000 });
    expect(projection.expectedCostUsd).toBeCloseTo(0.048, 9);
    expect(projectCampaign({ systems: ["A1"], scenarios: ["E0"], trials: 1, tokensPerCall: 10 }, null).expectedCostUsd).toBeNull();
  });

  it("stops once the reported spend reaches the ceiling", () => {
    expect(costGuardTripped(999, 1_000)).toBe(false);
    expect(costGuardTripped(1_000, 1_000)).toBe(true);
    expect(costGuardTripped(10 ** 9, null)).toBe(false);
  });
});

describe("token report", () => {
  const trial = (system: string, scenario: string, repeatedTokens: number, billedTokens = 600): TokenTrial => ({
    system, scenario, outcome: "SUCCEEDED", billedTokens, inputTokens: billedTokens, outputTokens: 0, repeatedTokens,
    repeatedLlmCalls: repeatedTokens > 0 ? 1 : 0, duplicateEffects: 0, reexecutedCommittedOperations: 0, recoveryMs: [1_000],
    usageProvenance: ["estimated"],
  });

  it("states ties and losses plainly and never calls scripted estimates billed", () => {
    const trials = [
      trial("A1", "E2B", 0), trial("A1", "E2B", 0),
      trial("C1", "E2B", 0), trial("C1", "E2B", 0),
      trial("DBOS", "E2B", 300), trial("DBOS", "E2B", 300),
    ];
    const { headlines, markdown } = renderTokenReport(trials, { provider: "scripted" });
    expect(headlines).toHaveLength(1);
    expect(headlines[0]).toContain("Under E2B, AgentFlow A1 repeated 0 (95% CI 0–0) estimated tokens per run");
    expect(headlines[0]).toContain("for C1 (Temporal-style) (tied with it)");
    expect(headlines[0]).toContain("300 (95% CI 300–300) for DBOS (fewer than it)");
    expect(headlines[0]).not.toContain("billed tokens");
    expect(markdown).toContain("estimated token counts from the scripted provider, not billed usage");
  });

  it("reports a loss when A1 repeats more, and labels live reported usage as billed", () => {
    const live = (system: string, repeated: number) => ({ ...trial(system, "E2", repeated), usageProvenance: ["reported"] });
    const { headlines } = renderTokenReport([live("A1", 400), live("C2", 300)], { provider: "groq", model: "openai/gpt-oss-120b" });
    expect(headlines[0]).toContain("400 (95% CI 400–400) billed tokens per run versus 300 (95% CI 300–300) for C2 (LangGraph-style) (more than it)");
    expect(headlines[0]).toContain("live groq openai/gpt-oss-120b");
  });

  it("attributes R1 savings to the cache, not to fault tolerance", () => {
    const { headlines } = renderTokenReport([
      trial("A1", "R1", 0, 600), trial("A1-cache", "R1", 0, 0),
    ], { provider: "scripted" });
    expect(headlines[0]).toMatch(/^Over R1 \(repeated identical runs\)/);
    expect(headlines[0]).toContain("not from fault tolerance");
  });
});

describe("live campaign sampling", () => {
  it("pins temperature 0 and a seed only for live definitions", () => {
    const live = cloudComparisonWorkflowDefinition({ mode: "live", provider: "groq", model: "openai/gpt-oss-120b" });
    expect(live.steps.filter((s) => s.kind === "AGENT").map((s) => s.kind === "AGENT" && [s.temperature, s.seed]))
      .toEqual([[0, 7], [0, 7]]);
    const scripted = cloudComparisonWorkflowDefinition({ context: "full" });
    expect(scripted.steps.some((s) => s.kind === "AGENT" && (s.temperature !== undefined || s.seed !== undefined))).toBe(false);
    expect(canonicalJson(referenceDefinition({ context: "full" }))).toBe(canonicalJson(scripted));
    expect(workflowDefinitionSchema.safeParse({ steps: [{ key: "a", kind: "AGENT", handler: "agent", provider: "p", model: "m", instructions: "x", temperature: 3 }] }).success).toBe(false);
  });

  it("adds seed to the journal key only when set, so existing hashes are unchanged", () => {
    const harness = new AgentHarness(new ProviderRegistry().register(new DeterministicFakeProvider()), new ToolRegistry());
    const base = { provider: "fake", request: { model: "m", messages: [] }, allowedTools: [] };
    expect(harness.journalKey(base).params).toEqual({ maxOutputTokens: null, temperature: null });
    expect(harness.journalKey({ ...base, request: { ...base.request, seed: 7 } }).params).toEqual({ maxOutputTokens: null, temperature: null, seed: 7 });
  });

  it("sends seed and temperature on the Groq wire", async () => {
    let body: Record<string, unknown> = {};
    const provider = new GroqProvider({
      apiKey: "k",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
      },
    });
    await provider.execute({ model: "m", messages: [{ role: "user", content: "q" }], temperature: 0, seed: 7 }, context);
    expect(body).toMatchObject({ temperature: 0, seed: 7 });
  });
});

describe("A1-nojournal ablation ordinals", () => {
  it("scopes harness ordinals to the attempt only when journal replay is disabled", () => {
    expect(harnessOrdinal(2, 3)).toBe(2);
    expect(harnessOrdinal(2, 3, { llmJournalReplay: true })).toBe(2);
    expect(harnessOrdinal(2, 3, { llmJournalReplay: false })).toBe(3_002);
  });
});
