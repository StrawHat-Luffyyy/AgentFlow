import { cloudComparisonWorkflowDefinition } from "@agentflow/research";
import {
  AgentInputProjectionError,
  canonicalJson,
  projectAgentInput,
  workflowDefinitionSchema,
} from "@agentflow/shared";
import { describe, expect, it } from "vitest";

const agent = (key: string, extra: Record<string, unknown> = {}) => ({
  key, kind: "AGENT", handler: "agent", provider: "fake", model: "m", instructions: "x", ...extra,
});

describe("projectAgentInput", () => {
  const input = {
    request: { publicationTarget: "controlled://publications/a", assumptions: { scope: "k8s" } },
    sourceSet: { sources: [{ id: "a" }], corpusHash: "h" },
    pricingAnalysis: { content: "long text" },
  };

  it("keeps only declared paths with their nesting", () => {
    expect(projectAgentInput(input, ["sourceSet", "request.assumptions"])).toEqual({
      sourceSet: { sources: [{ id: "a" }], corpusHash: "h" },
      request: { assumptions: { scope: "k8s" } },
    });
  });

  it("omits an absent nested path but throws on an absent root", () => {
    expect(projectAgentInput({ request: {} }, ["request.assumptions"])).toEqual({});
    expect(() => projectAgentInput(input, ["featureAnalysis"])).toThrow(AgentInputProjectionError);
  });

  it("does not share or mutate the source state", () => {
    const projected = projectAgentInput(input, ["sourceSet"]);
    (projected.sourceSet as { corpusHash: string }).corpusHash = "changed";
    expect(input.sourceSet.corpusHash).toBe("h");
  });
});

describe("agent inputs in workflow definitions", () => {
  const collect = [
    { key: "search-aws", kind: "DETERMINISTIC", handler: "select-aws-sources" },
    { key: "collect-sources", kind: "DETERMINISTIC", handler: "collect-sources" },
  ];

  it("rejects malformed and duplicate paths", () => {
    expect(workflowDefinitionSchema.safeParse({ steps: [agent("a", { inputs: ["bad path"] })] }).success).toBe(false);
    expect(workflowDefinitionSchema.safeParse({ steps: [agent("a", { inputs: ["x.", "y"] })] }).success).toBe(false);
    expect(workflowDefinitionSchema.safeParse({ steps: [agent("a", { inputs: ["x", "x"] })] }).success).toBe(false);
  });

  it("accepts the reference workflow's minimal declarations", () => {
    const definition = cloudComparisonWorkflowDefinition({ context: "minimal" });
    const analysis = definition.steps.filter((step) => step.kind === "AGENT");
    expect(analysis.map((step) => step.kind === "AGENT" && step.inputs)).toEqual([
      ["sourceSet", "request.assumptions"],
      ["sourceSet", "request.assumptions"],
    ]);
  });

  it("rejects an input that no upstream step produces", () => {
    const result = workflowDefinitionSchema.safeParse({
      steps: [...collect, agent("analyze-pricing", { outputKey: "pricingAnalysis", inputs: ["featureAnalysis"] })],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Agent input featureAnalysis: no upstream step produces featureAnalysis");
  });

  it("accepts an input produced by an earlier agent step's outputKey", () => {
    expect(workflowDefinitionSchema.safeParse({
      steps: [...collect, agent("one", { outputKey: "draft" }), agent("two", { inputs: ["draft", "sourceSet"] })],
    }).success).toBe(true);
  });

  it("knows which keys a handler drops", () => {
    expect(workflowDefinitionSchema.safeParse({
      steps: [...collect, { key: "report", kind: "DETERMINISTIC", handler: "generate-cloud-report" },
        agent("after-report", { inputs: ["request"] })],
    }).success).toBe(false);
  });

  it("defers validation to runtime while the state is still the open run input", () => {
    expect(workflowDefinitionSchema.safeParse({ steps: [agent("first", { inputs: ["anything"] })] }).success).toBe(true);
  });

  it("leaves definitions without inputs, and the full reference definition, unchanged", () => {
    const parsed = workflowDefinitionSchema.parse({ steps: [agent("a")] });
    expect(parsed.steps[0]).not.toHaveProperty("inputs");
    const full = cloudComparisonWorkflowDefinition({ context: "full" });
    expect(full.steps.some((step) => step.kind === "AGENT" && step.inputs !== undefined)).toBe(false);
    expect(canonicalJson(full)).not.toBe(canonicalJson(cloudComparisonWorkflowDefinition({ context: "minimal" })));
  });
});
