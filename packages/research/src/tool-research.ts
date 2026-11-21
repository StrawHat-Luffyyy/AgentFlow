// Multi-call evaluation workload: one AGENT step ("investigate") reads four corpus sources
// through a tool, one per turn, then answers. Five LLM calls in one step, so per-call
// journaling and per-step checkpointing behave differently after a mid-loop crash.
import {
  ProviderError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type ProviderCapabilities,
  type ProviderExecutionContext,
  type ToolDefinition,
} from "@agentflow/harness";
import { workflowDefinitionSchema, type WorkflowDefinition } from "@agentflow/shared";
import { z } from "zod";
import { fixedCloudComparisonCorpus } from "./corpus.js";

export const TOOL_RESEARCH_TAG = "[tool-research]";
export const TOOL_RESEARCH_STEP = "investigate";
export const READ_SOURCE_TOOL = "read-source";
/** The sources the scripted agent reads, in order: one tool call per turn. */
export const toolResearchSourceIds = ["aws-ec2-pricing", "azure-vm-pricing", "gcp-compute-pricing", "gcp-gke-overview"] as const;
/** Four tool-calling turns plus the final answer. */
export const toolResearchCallsPerRun = toolResearchSourceIds.length + 1;

export const toolResearchAnswer = "Across the four sources read, every vendor prices compute by region, size and purchase option, so no vendor can be ranked on price without a normalized live quote "
  + "[aws-ec2-pricing] [azure-vm-pricing] [gcp-compute-pricing]. GKE's Autopilot and Standard modes change the billing basis itself, which a comparison must hold constant [gcp-gke-overview].";

export function toolResearchWorkflowDefinition(): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    // Every first-time call must reach the provider: a run-scoped cache hit would blur the repeated-call metric.
    cacheScope: "off",
    steps: [
      { key: "search-aws", kind: "DETERMINISTIC", handler: "select-aws-sources" },
      { key: "search-azure", kind: "DETERMINISTIC", handler: "select-azure-sources" },
      { key: "search-gcp", kind: "DETERMINISTIC", handler: "select-gcp-sources" },
      { key: "collect-sources", kind: "DETERMINISTIC", handler: "collect-sources" },
      {
        key: TOOL_RESEARCH_STEP,
        kind: "AGENT",
        handler: "agent",
        provider: "scripted-tool-research",
        model: "tool-research-scripted-v1",
        instructions: `${TOOL_RESEARCH_TAG} Read the cited corpus sources one at a time with ${READ_SOURCE_TOOL}, then compare pricing evidence across vendors. Cite source IDs in square brackets.`,
        allowedTools: [READ_SOURCE_TOOL],
        maxTurns: toolResearchCallsPerRun + 1,
        maxOutputTokens: 1_500,
        outputKey: "investigation",
        inputs: ["sourceSet"],
      },
    ],
  });
}

const readSourceInput = z.object({ id: z.string().min(1).max(100) }).strict();
const readSourceOutput = z.object({ id: z.string(), title: z.string(), excerpt: z.string() });

/** PURE lookup over the fixed corpus, so re-running it after a crash is always safe. */
export const readSourceTool: ToolDefinition<z.infer<typeof readSourceInput>, z.infer<typeof readSourceOutput>> = {
  name: READ_SOURCE_TOOL,
  version: "1",
  description: "Return the title and excerpt of one fixed-corpus source by its id.",
  effectClass: "PURE",
  inputSchema: readSourceInput,
  outputSchema: readSourceOutput,
  providerSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Corpus source id, e.g. aws-ec2-pricing" } },
    required: ["id"],
    additionalProperties: false,
  },
  execute: ({ id }) => {
    const source = fixedCloudComparisonCorpus.find((document) => document.id === id);
    if (!source) throw new Error(`Unknown corpus source: ${id}`);
    return { id: source.id, title: source.title, excerpt: source.excerpt };
  },
};

const capabilities: ProviderCapabilities = {
  toolCalls: true,
  structuredOutput: false,
  streaming: false,
  contentTypes: ["text"],
  cancellation: true,
  serverSideState: false,
};

function tokenEstimate(value: string): number {
  const words = value.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words * 1.35));
}

/**
 * Deterministic tool-calling provider: on each call it reads the next source it has not yet
 * seen a tool result for, then answers once all four are in. Token counts use the same
 * word-count estimate as ScriptedResearchProvider (provenance "estimated").
 */
export class ScriptedToolResearchProvider implements LLMProvider {
  readonly name = "scripted-tool-research";
  readonly adapterVersion = "1.0.0";
  readonly capabilities = capabilities;

  async execute(request: LLMRequest, context: ProviderExecutionContext): Promise<LLMResponse> {
    if (context.signal?.aborted || context.deadlineAt.getTime() <= Date.now()) {
      throw new ProviderError("Scripted tool-research operation deadline expired", "TIMEOUT", "SCRIPTED_PROVIDER_TIMEOUT");
    }
    const instructions = request.instructions ?? "";
    if (!instructions.includes(TOOL_RESEARCH_TAG)) {
      throw new ProviderError("Scripted tool-research provider received an unsupported prompt", "PERMANENT", "UNSUPPORTED_SCRIPTED_PROMPT");
    }
    const read = request.messages.filter((message) => message.role === "tool").length;
    const next = toolResearchSourceIds[read];
    const inputTokens = tokenEstimate(`${instructions}\n${request.messages.map((message) => message.content).join("\n")}`);
    const base = {
      providerRequestId: `scripted-tool:${context.logicalOperationId}`,
      resolvedModel: request.model,
      opaqueState: { namespace: "agentflow.scripted-tool-research", version: 1, turn: read + 1 },
    };
    if (next) {
      const text = `Reading ${next}.`;
      return {
        ...base,
        text,
        toolCalls: [{ id: `read-${read + 1}`, name: READ_SOURCE_TOOL, arguments: { id: next } }],
        finishReason: "tool_calls",
        usage: {
          provenance: "estimated", inputTokens, outputTokens: tokenEstimate(text), cachedInputTokens: 0, reasoningTokens: null,
          raw: { scripted: true, estimator: "word-count-1.35", turn: read + 1 },
        },
      };
    }
    return {
      ...base,
      text: toolResearchAnswer,
      toolCalls: [],
      finishReason: "stop",
      usage: {
        provenance: "estimated", inputTokens, outputTokens: tokenEstimate(toolResearchAnswer), cachedInputTokens: 0, reasoningTokens: null,
        raw: { scripted: true, estimator: "word-count-1.35", turn: read + 1 },
      },
    };
  }
}
