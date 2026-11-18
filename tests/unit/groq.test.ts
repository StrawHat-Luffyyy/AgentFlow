import {
  AgentHarness,
  GroqProvider,
  HarnessValidationError,
  ProviderError,
  ProviderRegistry,
  ToolRegistry,
  type ProviderExecutionContext,
} from "@agentflow/harness";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const context: ProviderExecutionContext = {
  runId: "00000000-0000-4000-8000-000000000001",
  logicalOperationId: "00000000-0000-4000-8000-000000000002",
  attemptId: "00000000-0000-4000-8000-000000000003",
  deadlineAt: new Date(Date.now() + 60_000),
};

interface Captured { url: string; init: RequestInit; body: Record<string, unknown> }

function wire(responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Captured[] = [];
  const fetchStub = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json", ...next.headers },
    });
  };
  return { calls, provider: new GroqProvider({ apiKey: "test-groq-key", fetch: fetchStub }) };
}

const completion = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "openai/gpt-oss-120b",
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }],
  usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62, queue_time: 0.01 },
  system_fingerprint: "fp_1",
  x_groq: { id: "req_abc" },
  ...extra,
});

describe("GroqProvider wire format", () => {
  it("sends an OpenAI-compatible chat request and normalizes the response", async () => {
    const { calls, provider } = wire([{ body: completion({ content: "hello" }) }]);
    const response = await provider.execute({
      model: "openai/gpt-oss-120b",
      instructions: "Be concise.",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 128,
      temperature: 0,
    }, context);

    expect(calls[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer test-groq-key");
    expect(calls[0]!.body).toEqual({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "system", content: "Be concise." }, { role: "user", content: "hi" }],
      max_completion_tokens: 128,
      temperature: 0,
    });
    expect(response).toMatchObject({
      text: "hello",
      finishReason: "stop",
      toolCalls: [],
      providerRequestId: "req_abc",
      resolvedModel: "openai/gpt-oss-120b",
      opaqueState: null,
      usage: {
        provenance: "reported",
        inputTokens: 50,
        outputTokens: 12,
        cachedInputTokens: null,
        reasoningTokens: null,
        totalTokens: 62,
      },
    });
  });

  it("captures cached and reasoning token details when the API reports them", async () => {
    const { provider } = wire([{
      body: completion({ content: "ok" }, {
        usage: {
          prompt_tokens: 900, completion_tokens: 40, total_tokens: 940,
          prompt_tokens_details: { cached_tokens: 768 },
          completion_tokens_details: { reasoning_tokens: 25 },
        },
      }),
    }]);
    const { usage } = await provider.execute({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }] }, context);
    expect(usage).toMatchObject({ inputTokens: 900, cachedInputTokens: 768, outputTokens: 40, reasoningTokens: 25, totalTokens: 940 });
  });

  it("marks usage unknown with null counts when the response has no usage, never estimating", async () => {
    const { provider } = wire([{ body: { ...completion({ content: "ok" }), usage: undefined } }]);
    const { usage } = await provider.execute({ model: "m", messages: [{ role: "user", content: "hi" }] }, context);
    expect(usage).toEqual({
      provenance: "unknown", inputTokens: null, outputTokens: null, cachedInputTokens: null,
      reasoningTokens: null, totalTokens: null, raw: {},
    });
  });

  it("sends tools, parses tool calls, and round-trips tool results", async () => {
    const { calls, provider } = wire([
      {
        body: {
          ...completion({
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "compute_sum", arguments: "{\"a\":1,\"b\":2}" } }],
          }),
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "compute_sum", arguments: "{\"a\":1,\"b\":2}" } }],
            },
            finish_reason: "tool_calls",
          }],
        },
      },
      { body: completion({ content: "3" }) },
    ]);
    const tool = {
      name: "compute_sum",
      description: "Adds",
      inputSchema: { type: "object" as const, properties: { a: { type: "number" }, b: { type: "number" } } },
    };
    const first = await provider.execute({ model: "m", messages: [{ role: "user", content: "add" }], tools: [tool] }, context);
    expect(calls[0]!.body.tools).toEqual([{ type: "function", function: { name: "compute_sum", description: "Adds", parameters: tool.inputSchema } }]);
    expect(calls[0]!.body.parallel_tool_calls).toBe(false);
    expect(first.finishReason).toBe("tool_calls");
    expect(first.toolCalls).toEqual([{ id: "call_1", name: "compute_sum", arguments: { a: 1, b: 2 } }]);

    await provider.execute({
      model: "m",
      messages: [
        { role: "user", content: "add" },
        { role: "assistant", content: "", toolCalls: first.toolCalls },
        { role: "tool", name: "compute_sum", toolCallId: "call_1", content: "{\"sum\":3}" },
      ],
      tools: [tool],
    }, context);
    expect(calls[1]!.body.messages).toEqual([
      { role: "user", content: "add" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "compute_sum", arguments: "{\"a\":1,\"b\":2}" } }] },
      { role: "tool", content: "{\"sum\":3}", tool_call_id: "call_1", name: "compute_sum" },
    ]);
  });

  it("requests strict json_schema structured output and rejects it alongside tools", async () => {
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
    const { calls, provider } = wire([{ body: completion({ content: "{\"answer\":\"x\"}" }) }]);
    await provider.execute({ model: "m", messages: [{ role: "user", content: "q" }], opaqueState: { responseSchema: schema } }, context);
    expect(calls[0]!.body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "agentflow_response", schema, strict: true },
    });

    await expect(provider.execute({
      model: "m",
      messages: [{ role: "user", content: "q" }],
      opaqueState: { responseSchema: schema },
      tools: [{ name: "t", description: "t", inputSchema: { type: "object" } }],
    }, context)).rejects.toMatchObject({ errorClass: "PERMANENT", code: "GROQ_STRUCTURED_OUTPUT_WITH_TOOLS_UNSUPPORTED" });
  });

  it("rejects malformed tool-call arguments as a permanent provider error", async () => {
    const { provider } = wire([{
      body: completion({ content: null, tool_calls: [{ id: "c", type: "function", function: { name: "t", arguments: "{not json" } }] }),
    }]);
    await expect(provider.execute({ model: "m", messages: [{ role: "user", content: "q" }] }, context))
      .rejects.toMatchObject({ errorClass: "PERMANENT", code: "MALFORMED_PROVIDER_RESPONSE" });
  });
});

describe("GroqProvider error classification", () => {
  const failWith = async (status: number, headers: Record<string, string> = {}) => {
    const { provider } = wire([{ status, headers, body: { error: { message: `status ${status}`, type: "invalid_request_error" } } }]);
    return provider.execute({ model: "m", messages: [{ role: "user", content: "q" }] }, context).catch((error: unknown) => error);
  };

  it.each([429, 498, 500, 502, 503])("classifies HTTP %i as TRANSIENT", async (status) => {
    const error = await failWith(status);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ errorClass: "TRANSIENT", code: `GROQ_HTTP_${status}`, status });
  });

  it.each([400, 401, 403, 404, 413, 422])("classifies HTTP %i as PERMANENT", async (status) => {
    expect(await failWith(status)).toMatchObject({ errorClass: "PERMANENT", code: `GROQ_HTTP_${status}` });
  });

  it("honors retry-after on 429 and surfaces the error message", async () => {
    const error = await failWith(429, { "retry-after": "7" }) as ProviderError;
    expect(error.retryAfterMs).toBe(7_000);
    expect(error.message).toContain("status 429");
  });

  it("classifies aborts as TIMEOUT and network failures as TRANSIENT with unknown outcome", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { provider: aborted } = wire([abort]);
    await expect(aborted.execute({ model: "m", messages: [{ role: "user", content: "q" }] }, context))
      .rejects.toMatchObject({ errorClass: "TIMEOUT", outcomeUnknown: true });
    const { provider: offline } = wire([new TypeError("fetch failed")]);
    await expect(offline.execute({ model: "m", messages: [{ role: "user", content: "q" }] }, context))
      .rejects.toMatchObject({ errorClass: "TRANSIENT", outcomeUnknown: true });
  });
});

describe("GroqProvider in the harness", () => {
  it("is subject to the same harness tool allowlist as every provider", async () => {
    const { provider } = wire([{
      body: completion({ content: null, tool_calls: [{ id: "c", type: "function", function: { name: "forbidden", arguments: "{}" } }] }),
    }]);
    const tools = new ToolRegistry().register({
      name: "allowed",
      version: "1",
      description: "Allowed tool",
      effectClass: "PURE",
      providerSchema: { type: "object" },
      inputSchema: z.object({}),
      outputSchema: z.unknown(),
      execute: () => ({}),
    });
    const harness = new AgentHarness(new ProviderRegistry().register(provider), tools);
    await expect(harness.executeModelOperation({
      provider: "groq",
      request: { model: "m", messages: [{ role: "user", content: "q" }] },
      allowedTools: ["allowed"],
      turn: 1,
      maxTurns: 2,
      context,
    })).rejects.toBeInstanceOf(HarnessValidationError);
  });

  it("gets a distinct journal key from Gemini-shaped requests via provider identity", () => {
    const { provider } = wire([]);
    const harness = new AgentHarness(new ProviderRegistry().register(provider), new ToolRegistry());
    const key = harness.journalKey({ provider: "groq", request: { model: "m", messages: [] }, allowedTools: [] });
    expect(key).toMatchObject({ provider: "groq", adapterVersion: "1.0.0" });
  });
});
