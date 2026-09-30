import {
  AgentHarness,
  DeterministicFakeProvider,
  HarnessValidationError,
  OllamaProvider,
  OpenAIResponsesProvider,
  ProviderRegistry,
  ToolRegistry,
  TurnLimitError,
  createHttpTargetValidator,
  type LLMResponse,
  type ProviderExecutionContext,
} from "@agentflow/harness";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const context: ProviderExecutionContext = {
  runId: "00000000-0000-4000-8000-000000000001",
  logicalOperationId: "00000000-0000-4000-8000-000000000002",
  attemptId: "00000000-0000-4000-8000-000000000003",
  deadlineAt: new Date(Date.now() + 60_000),
};

const scriptedToolResponse: LLMResponse = {
  text: "",
  toolCalls: [{ id: "call-1", name: "fetch-page", arguments: { url: "https://docs.example.com/a" } }],
  finishReason: "tool_calls",
  usage: {
    provenance: "reported",
    inputTokens: 5,
    outputTokens: 2,
    cachedInputTokens: 1,
    reasoningTokens: 0,
    raw: {},
  },
  providerRequestId: "fake-1",
  resolvedModel: "fake-model",
  opaqueState: { namespace: "fake", version: 1 },
};

function toolRegistry() {
  return new ToolRegistry().register({
    name: "fetch-page",
    version: "1",
    description: "Fetch one approved documentation page",
    effectClass: "REPEATABLE_READ",
    providerSchema: {
      type: "object",
      properties: { url: { type: "string", format: "uri" } },
      required: ["url"],
      additionalProperties: false,
    },
    inputSchema: z.object({ url: z.string().url() }).strict(),
    outputSchema: z.object({ status: z.number().int(), url: z.string().url() }),
    validateTarget: createHttpTargetValidator("url", ["docs.example.com"]),
    execute: ({ url }) => ({ status: 200, url }),
  });
}

describe("AgentHarness", () => {
  it("exposes only allowlisted tools and executes each call as an explicit operation", async () => {
    const fake = new DeterministicFakeProvider([scriptedToolResponse]);
    const tools = toolRegistry();
    const harness = new AgentHarness(new ProviderRegistry().register(fake), tools);

    const response = await harness.executeModelOperation({
      provider: "fake",
      request: { model: "fake-model", messages: [{ role: "user", content: "read docs" }] },
      allowedTools: ["fetch-page"],
      turn: 1,
      maxTurns: 2,
      context,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.request.tools?.map((tool) => tool.name)).toEqual(["fetch-page"]);
    expect(response.toolCalls).toEqual(scriptedToolResponse.toolCalls);

    const result = await harness.executeToolOperation({
      call: response.toolCalls[0]!,
      allowedTools: ["fetch-page"],
      context,
    });
    expect(result).toMatchObject({ name: "fetch-page", version: "1", output: { status: 200 } });
  });

  it("rejects turn overflow, non-allowlisted tools, invalid arguments, and disallowed targets", async () => {
    const tools = toolRegistry();
    const harness = new AgentHarness(
      new ProviderRegistry().register(new DeterministicFakeProvider([scriptedToolResponse])),
      tools,
    );
    await expect(harness.executeModelOperation({
      provider: "fake",
      request: { model: "fake", messages: [] },
      allowedTools: ["fetch-page"],
      turn: 3,
      maxTurns: 2,
      context,
    })).rejects.toBeInstanceOf(TurnLimitError);
    expect(() => tools.validateCall(scriptedToolResponse.toolCalls[0]!, [])).toThrowError(HarnessValidationError);
    expect(() => tools.validateCall({
      id: "bad",
      name: "fetch-page",
      arguments: { url: 12 },
    }, ["fetch-page"])).toThrowError(/Invalid arguments/);
    await expect(tools.execute({
      id: "target",
      name: "fetch-page",
      arguments: { url: "https://evil.example/a" },
    }, ["fetch-page"], { ...context, toolCallId: "target" })).rejects.toThrowError(/not allowed/);
  });

  it("is deterministic for identical fake-provider scripts", async () => {
    const first = new DeterministicFakeProvider();
    const second = new DeterministicFakeProvider();
    const request = { model: "fixed", messages: [{ role: "user" as const, content: "same" }] };
    expect(await first.execute(request, context)).toEqual(await second.execute(request, context));
  });

  it("rejects multiple tool calls so each turn has one ordered tool operation", async () => {
    const response: LLMResponse = {
      ...scriptedToolResponse,
      toolCalls: [
        scriptedToolResponse.toolCalls[0]!,
        { id: "call-2", name: "fetch-page", arguments: { url: "https://docs.example.com/b" } },
      ],
    };
    const harness = new AgentHarness(
      new ProviderRegistry().register(new DeterministicFakeProvider([response])),
      toolRegistry(),
    );
    await expect(harness.executeModelOperation({
      provider: "fake",
      request: { model: "fake", messages: [{ role: "user", content: "read" }] },
      allowedTools: ["fetch-page"],
      turn: 1,
      maxTurns: 2,
      context,
    })).rejects.toMatchObject({ code: "MULTIPLE_TOOL_CALLS_UNSUPPORTED" });
  });
});

describe("provider adapters", () => {
  it("normalizes an OpenAI Responses tool call, usage, and continuation state", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "gpt-test", store: true });
      expect(body.tools).toEqual([expect.objectContaining({ name: "fetch-page", strict: true })]);
      return new Response(JSON.stringify({
        id: "resp_123",
        model: "gpt-test-2026-09-01",
        status: "completed",
        output: [{
          type: "function_call",
          call_id: "call_123",
          name: "fetch-page",
          arguments: "{\"url\":\"https://docs.example.com/a\"}",
        }],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens_details: { reasoning_tokens: 2 },
        },
      }), { status: 200, headers: { "x-request-id": "request_123" } });
    });
    const provider = new OpenAIResponsesProvider({ apiKey: "test", fetch });
    const response = await provider.execute({
      model: "gpt-test",
      messages: [{ role: "user", content: "read" }],
      tools: toolRegistry().providerTools(["fetch-page"]),
    }, context);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      finishReason: "tool_calls",
      providerRequestId: "request_123",
      resolvedModel: "gpt-test-2026-09-01",
      usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, reasoningTokens: 2 },
      opaqueState: { namespace: "openai.responses", previousResponseId: "resp_123" },
    });
    expect(response.toolCalls[0]).toEqual({
      id: "call_123",
      name: "fetch-page",
      arguments: { url: "https://docs.example.com/a" },
    });
  });

  it("normalizes Ollama chat calls and reported token counts", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      model: "qwen3:8b",
      done: true,
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "fetch-page", arguments: { url: "https://docs.example.com/a" } } }],
      },
      prompt_eval_count: 12,
      eval_count: 5,
      context: [1, 2, 3],
    }), { status: 200 }));
    const provider = new OllamaProvider({ baseUrl: "http://ollama.test", fetch });
    const response = await provider.execute({
      model: "qwen3:8b",
      messages: [{ role: "user", content: "read" }],
      tools: toolRegistry().providerTools(["fetch-page"]),
    }, context);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response.finishReason).toBe("tool_calls");
    expect(response.usage).toMatchObject({ inputTokens: 12, outputTokens: 5, provenance: "reported" });
    expect(response.opaqueState).toEqual({ namespace: "ollama.chat", version: 1, context: [1, 2, 3] });
    expect(response.toolCalls[0]?.id).toContain(context.logicalOperationId);
  });
});
