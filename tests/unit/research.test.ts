import {
  ScriptedResearchProvider,
  cloudComparisonCorpusHash,
  cloudComparisonSetupSchema,
  cloudComparisonWorkflowDefinition,
  fixedSourceContentHash,
  fixedCloudComparisonCorpus,
} from "@agentflow/research";
import { describe, expect, it } from "vitest";

describe("cloud-comparison reference assets", () => {
  it("keeps a versioned fixed corpus with verifiable evidence hashes", () => {
    expect(fixedCloudComparisonCorpus).toHaveLength(6);
    expect(cloudComparisonCorpusHash).toMatch(/^[a-f0-9]{64}$/);
    for (const source of fixedCloudComparisonCorpus) {
      const { contentHash: _contentHash, ...snapshot } = source;
      expect(source.contentHash).toBe(fixedSourceContentHash(snapshot));
      expect(source.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it("builds the same nine-step workflow for live and scripted providers", () => {
    const scripted = cloudComparisonWorkflowDefinition();
    const live = cloudComparisonWorkflowDefinition({
      mode: "live",
      provider: "openai",
      model: "test-model",
    });
    const expectedKeys = [
      "search-aws",
      "search-azure",
      "search-gcp",
      "collect-sources",
      "analyze-pricing",
      "analyze-features",
      "generate-report",
      "approve-publication",
      "publish-report",
    ];
    expect(scripted.steps.map((step) => step.key)).toEqual(expectedKeys);
    expect(live.steps.map((step) => step.key)).toEqual(expectedKeys);
    expect(scripted.steps[4]).toMatchObject({ kind: "AGENT", provider: "scripted-research" });
    expect(live.steps[4]).toMatchObject({ kind: "AGENT", provider: "openai", model: "test-model" });
    expect(scripted.steps[8]).toMatchObject({
      kind: "TOOL",
      handler: "publish-approved-report",
      effectClass: "RECEIVER_IDEMPOTENT_WRITE",
    });
    expect(() => cloudComparisonSetupSchema.parse({ mode: "live" })).toThrow();
  });

  it("produces deterministic scripted analyses with estimated usage", async () => {
    const provider = new ScriptedResearchProvider();
    const context = {
      runId: "00000000-0000-4000-8000-000000000001",
      logicalOperationId: "00000000-0000-4000-8000-000000000002",
      attemptId: "00000000-0000-4000-8000-000000000003",
      deadlineAt: new Date(Date.now() + 60_000),
    };
    const request = {
      model: "cloud-comparison-scripted-v1",
      instructions: "[cloud-comparison:pricing] fixed task",
      messages: [{ role: "user" as const, content: "fixed corpus" }],
    };
    const first = await provider.execute(request, context);
    const second = await provider.execute(request, context);
    expect(first).toEqual(second);
    expect(first.text).toContain("[aws-ec2-pricing]");
    expect(first.usage).toMatchObject({ provenance: "estimated" });
  });
});
