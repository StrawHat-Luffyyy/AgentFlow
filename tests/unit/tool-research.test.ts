import { AgentHarness, ProviderRegistry, ToolRegistry, type LLMMessage, type ProviderExecutionContext } from "@agentflow/harness";
import {
  ScriptedToolResearchProvider, TOOL_RESEARCH_STEP, readSourceTool, toolResearchAnswer, toolResearchCallsPerRun,
  toolResearchSourceIds, toolResearchWorkflowDefinition,
} from "@agentflow/research";
import type { ClaimedOperation } from "@agentflow/runtime";
import { describe, expect, it } from "vitest";
import { createProcessFaultHooks } from "../../packages/evaluation/src/process-hooks.js";
import { projectCampaign } from "../../packages/evaluation/src/campaign-plan.js";
import { referenceDefinition } from "../../packages/evaluation/src/real-common.js";
import { llmEventMetrics } from "../../packages/evaluation/src/real-metrics.js";

const context: ProviderExecutionContext = {
  runId: "r", logicalOperationId: "o", attemptId: "a", deadlineAt: new Date(Date.now() + 60_000),
};

describe("tool-research workload", () => {
  const definition = toolResearchWorkflowDefinition();
  const step = definition.steps.find((candidate) => candidate.key === TOOL_RESEARCH_STEP)!;

  it("is one agent step that may call read-source, with the cache off", () => {
    expect(definition.cacheScope).toBe("off");
    expect(step).toMatchObject({ kind: "AGENT", allowedTools: ["read-source"], inputs: ["sourceSet"], maxTurns: toolResearchCallsPerRun + 1 });
    expect(referenceDefinition({ workload: "tool-research" })).toEqual(definition);
  });

  it("scripts four source lookups, one per call, then the answer", async () => {
    const harness = new AgentHarness(
      new ProviderRegistry().register(new ScriptedToolResearchProvider()),
      new ToolRegistry().register(readSourceTool),
    );
    if (step.kind !== "AGENT") throw new Error("expected an agent step");
    const messages: LLMMessage[] = [{ role: "user", content: "{}" }];
    const read: string[] = [];
    for (let turn = 1; turn <= toolResearchCallsPerRun; turn++) {
      const response = await harness.executeModelOperation({
        provider: step.provider, request: { model: step.model, instructions: step.instructions, messages: [...messages] },
        allowedTools: step.allowedTools, turn, maxTurns: step.maxTurns, context,
      });
      expect(response.usage.provenance).toBe("estimated");
      if (turn === toolResearchCallsPerRun) {
        expect(response).toMatchObject({ text: toolResearchAnswer, toolCalls: [], finishReason: "stop" });
        break;
      }
      const call = response.toolCalls[0]!;
      read.push(String(call.arguments.id));
      const tool = await harness.executeToolOperation({ call, allowedTools: step.allowedTools, context: { ...context, logicalOperationId: `t${turn}` } });
      messages.push({ role: "assistant", content: response.text, toolCalls: [call] });
      messages.push({ role: "tool", content: JSON.stringify(tool.output), toolCallId: call.id, name: call.name });
    }
    expect(read).toEqual([...toolResearchSourceIds]);
    for (const id of toolResearchSourceIds) expect(toolResearchAnswer).toContain(`[${id}]`);
  });

  it("read-source returns corpus excerpts and rejects unknown ids", () => {
    expect(readSourceTool.execute({ id: "aws-ec2-pricing" }, { ...context, toolCallId: "c" })).toMatchObject({ id: "aws-ec2-pricing" });
    expect(() => readSourceTool.execute({ id: "nope" }, { ...context, toolCallId: "c" })).toThrow(/Unknown corpus source/);
    expect(readSourceTool.inputSchema.safeParse({ id: "x", extra: 1 }).success).toBe(false);
  });

  it("projects five calls per run for the dry-run cost estimate", () => {
    const projection = projectCampaign({ systems: ["A1"], scenarios: ["E0"], trials: 2, tokensPerCall: 100, callsPerRun: toolResearchCallsPerRun }, null);
    expect(projection.expectedCalls).toBe(10);
  });
});

describe("turn-aware fault plans", () => {
  const operation = { nodeKey: TOOL_RESEARCH_STEP } as ClaimedOperation;
  const crash = () => { throw new Error("terminated"); };

  it("fires a step#turn fault only on that LLM call", () => {
    const hooks = createProcessFaultHooks([
      { id: "f", hook: "after-llm-journal-commit", action: "crash", operationId: `${TOOL_RESEARCH_STEP}#3`, occurrence: 1 },
    ], { terminate: crash as () => never });
    expect(() => hooks.hit("after-llm-journal-commit", operation, { turn: 1 })).not.toThrow();
    expect(() => hooks.hit("after-llm-journal-commit", operation, { turn: 2 })).not.toThrow();
    expect(() => hooks.hit("after-llm-journal-commit", operation, { turn: 3 })).toThrow("terminated");
  });

  it("keeps a bare step key matching its first call, as before turns existed", () => {
    const hooks = createProcessFaultHooks([
      { id: "f", hook: "after-llm-journal-commit", action: "crash", operationId: TOOL_RESEARCH_STEP, occurrence: 1 },
    ], { terminate: crash as () => never });
    expect(() => hooks.hit("after-llm-journal-commit", operation, { turn: 1 })).toThrow("terminated");
  });
});

describe("llmEventMetrics per LLM call", () => {
  const call = (turn: number) => [
    { event: "provider-start", operation: TOOL_RESEARCH_STEP, detail: { turn } },
    { event: "provider-result", operation: TOOL_RESEARCH_STEP, detail: { turn, usage: { inputTokens: 10 * turn, outputTokens: 5, provenance: "estimated" } } },
  ];
  const calls = (...turns: number[]) => turns.flatMap(call);

  it("does not count the calls of one agent loop as repeats of each other", () => {
    expect(llmEventMetrics(calls(1, 2, 3, 4, 5))).toMatchObject({ llmCalls: 5, repeatedLlmCalls: 0, repeatedTokens: 0 });
  });

  it("counts calls 1-3 again when a crash after call 3 restarts the loop, and none when they were replayed", () => {
    expect(llmEventMetrics(calls(1, 2, 3, 1, 2, 3, 4, 5))).toMatchObject({ llmCalls: 8, repeatedLlmCalls: 3, repeatedTokens: 75 });
    expect(llmEventMetrics(calls(1, 2, 3, 4, 5))).toMatchObject({ repeatedLlmCalls: 0 });
  });

  it("treats events without a turn as turn 1, so earlier campaigns read the same", () => {
    const old = [
      { event: "provider-start", operation: "analyze-features", detail: {} },
      { event: "provider-start", operation: "analyze-features", detail: { turn: 1 } },
    ];
    expect(llmEventMetrics(old).repeatedLlmCalls).toBe(1);
  });
});
