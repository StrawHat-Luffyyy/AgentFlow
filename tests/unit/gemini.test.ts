import { ApiError, type GoogleGenAI } from "@google/genai";
import { GeminiProvider, type ProviderExecutionContext } from "@agentflow/harness";
import { describe, expect, it, vi } from "vitest";

const testContext: ProviderExecutionContext = {
  runId: "00000000-0000-4000-8000-000000000001",
  logicalOperationId: "00000000-0000-4000-8000-000000000002",
  attemptId: "00000000-0000-4000-8000-000000000003",
  deadlineAt: new Date(Date.now() + 60_000),
};

describe("GeminiProvider adapter unit tests (deterministic / mocked)", () => {
  it("constructs requests with system instructions, messages, and model options", async () => {
    let capturedParams: any = null;
    const mockClient = {
      models: {
        generateContent: vi.fn(async (params: any) => {
          capturedParams = params;
          return {
            text: "Hello from Gemini",
            candidates: [{ finishReason: "STOP" }],
            usageMetadata: {
              promptTokenCount: 15,
              candidatesTokenCount: 8,
              totalTokenCount: 23,
            },
            modelVersion: "gemini-3.5-flash-v1",
            responseId: "resp-gemini-001",
          };
        }),
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiProvider({
      apiKey: "test-fake-key",
      model: "gemini-3.5-flash",
      client: mockClient,
    });

    const response = await provider.execute(
      {
        model: "gemini-3.5-flash",
        instructions: "You are an AI research assistant.",
        temperature: 0.2,
        maxOutputTokens: 1024,
        messages: [
          { role: "user", content: "What is cloud computing?" },
          { role: "assistant", content: "Cloud computing is on-demand compute delivery." },
          { role: "user", content: "Summarize in 3 words." },
        ],
      },
      testContext,
    );

    expect(mockClient.models.generateContent).toHaveBeenCalledTimes(1);
    expect(capturedParams.model).toBe("gemini-3.5-flash");
    expect(capturedParams.config.systemInstruction).toBe("You are an AI research assistant.");
    expect(capturedParams.config.temperature).toBe(0.2);
    expect(capturedParams.config.maxOutputTokens).toBe(1024);

    expect(capturedParams.contents).toHaveLength(3);
    expect(capturedParams.contents[0]).toEqual({ role: "user", parts: [{ text: "What is cloud computing?" }] });
    expect(capturedParams.contents[1]).toEqual({ role: "model", parts: [{ text: "Cloud computing is on-demand compute delivery." }] });
    expect(capturedParams.contents[2]).toEqual({ role: "user", parts: [{ text: "Summarize in 3 words." }] });

    expect(response.text).toBe("Hello from Gemini");
    expect(response.finishReason).toBe("stop");
    expect(response.resolvedModel).toBe("gemini-3.5-flash-v1");
    expect(response.providerRequestId).toBe("resp-gemini-001");
    expect(response.usage).toEqual({
      provenance: "reported",
      inputTokens: 15,
      outputTokens: 8,
      cachedInputTokens: null,
      reasoningTokens: null,
      raw: {
        promptTokenCount: 15,
        candidatesTokenCount: 8,
        totalTokenCount: 23,
      },
    });
    expect(response.opaqueState).toEqual({
      namespace: "gemini.generateContent",
      version: 1,
      consumedMessages: 4,
    });
  });

  it("normalizes function/tool declarations and extracts tool calls", async () => {
    let capturedParams: any = null;
    const mockClient = {
      models: {
        generateContent: vi.fn(async (params: any) => {
          capturedParams = params;
          return {
            text: "",
            functionCalls: [
              {
                id: "call-g-100",
                name: "fetch-cloud-data",
                args: { region: "us-east-1", instances: 4 },
              },
            ],
            candidates: [{ finishReason: "STOP" }],
            usageMetadata: {
              promptTokenCount: 40,
              candidatesTokenCount: 12,
              cachedContentTokenCount: 10,
            },
          };
        }),
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiProvider({ apiKey: "test-fake-key", client: mockClient });
    const response = await provider.execute(
      {
        model: "gemini-3.5-flash",
        messages: [{ role: "user", content: "Query instances" }],
        tools: [
          {
            name: "fetch-cloud-data",
            description: "Fetches cloud resources by region",
            inputSchema: {
              type: "object",
              properties: { region: { type: "string" }, instances: { type: "number" } },
              required: ["region"],
            },
          },
        ],
      },
      testContext,
    );

    expect(capturedParams.config.tools).toHaveLength(1);
    expect(capturedParams.config.tools[0].functionDeclarations).toEqual([
      {
        name: "fetch-cloud-data",
        description: "Fetches cloud resources by region",
        parameters: {
          type: "object",
          properties: { region: { type: "string" }, instances: { type: "number" } },
          required: ["region"],
        },
      },
    ]);

    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]).toEqual({
      id: "call-g-100",
      name: "fetch-cloud-data",
      arguments: { region: "us-east-1", instances: 4 },
    });
    expect(response.usage.cachedInputTokens).toBe(10);
  });

  it("normalizes multi-turn tool output messages back into user functionResponse parts", async () => {
    let capturedParams: any = null;
    const mockClient = {
      models: {
        generateContent: vi.fn(async (params: any) => {
          capturedParams = params;
          return {
            text: "Final analysis complete based on tool result.",
            candidates: [{ finishReason: "STOP" }],
          };
        }),
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiProvider({ apiKey: "test-fake-key", client: mockClient });
    await provider.execute(
      {
        model: "gemini-3.5-flash",
        messages: [
          { role: "user", content: "Start task" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-1", name: "get_status", arguments: { id: "item-1" } }],
          },
          {
            role: "tool",
            name: "get_status",
            toolCallId: "call-1",
            content: JSON.stringify({ active: true, load: 0.42 }),
          },
        ],
      },
      testContext,
    );

    expect(capturedParams.contents).toHaveLength(3);
    expect(capturedParams.contents[1]).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "get_status", args: { id: "item-1" } } }],
    });
    expect(capturedParams.contents[2]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "get_status",
            response: { active: true, load: 0.42 },
          },
        },
      ],
    });
  });

  it("applies structured output configuration when schema is supplied in opaqueState", async () => {
    let capturedParams: any = null;
    const mockClient = {
      models: {
        generateContent: vi.fn(async (params: any) => {
          capturedParams = params;
          return {
            text: JSON.stringify({ score: 98, verdict: "approved" }),
            candidates: [{ finishReason: "STOP" }],
          };
        }),
      },
    } as unknown as GoogleGenAI;

    const schema = {
      type: "object",
      properties: { score: { type: "number" }, verdict: { type: "string" } },
      required: ["score", "verdict"],
    };

    const provider = new GeminiProvider({ apiKey: "test-fake-key", client: mockClient });
    const response = await provider.execute(
      {
        model: "gemini-3.5-flash",
        messages: [{ role: "user", content: "Analyze metrics" }],
        opaqueState: { responseSchema: schema },
      },
      testContext,
    );

    expect(capturedParams.config.responseMimeType).toBe("application/json");
    expect(capturedParams.config.responseSchema).toEqual(schema);
    expect(JSON.parse(response.text)).toEqual({ score: 98, verdict: "approved" });
  });

  it("classifies rate limit / 429 as TRANSIENT error", async () => {
    const mockClient = {
      models: {
        generateContent: vi.fn(async () => {
          throw new ApiError({
            message: "RESOURCE_EXHAUSTED: Quota exceeded for gemini-3.5-flash",
            status: 429,
          });
        }),
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiProvider({ apiKey: "test-fake-key", client: mockClient });
    await expect(
      provider.execute({ model: "gemini-3.5-flash", messages: [] }, testContext),
    ).rejects.toMatchObject({
      errorClass: "TRANSIENT",
      code: "GEMINI_HTTP_429",
      status: 429,
    });
  });

  it("classifies 503 / UNAVAILABLE as TRANSIENT error", async () => {
    const mockClient = {
      models: {
        generateContent: vi.fn(async () => {
          throw new ApiError({
            message: "The service is temporarily unavailable",
            status: 503,
          });
        }),
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiProvider({ apiKey: "test-fake-key", client: mockClient });
    await expect(
      provider.execute({ model: "gemini-3.5-flash", messages: [] }, testContext),
    ).rejects.toMatchObject({
      errorClass: "TRANSIENT",
      code: "GEMINI_HTTP_503",
      status: 503,
    });
  });

  it("classifies 400 / 401 / 403 as PERMANENT error", async () => {
    const mockClient = {
      models: {
        generateContent: vi.fn(async () => {
          throw new ApiError({
            message: "API_KEY_INVALID: User not authorized",
            status: 401,
          });
        }),
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiProvider({ apiKey: "test-fake-key", client: mockClient });
    await expect(
      provider.execute({ model: "gemini-3.5-flash", messages: [] }, testContext),
    ).rejects.toMatchObject({
      errorClass: "PERMANENT",
      code: "GEMINI_HTTP_401",
      status: 401,
    });
  });

  it("classifies timeout or aborted signal as TIMEOUT error", async () => {
    const controller = new AbortController();
    controller.abort();

    const mockClient = {
      models: {
        generateContent: vi.fn(async () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          throw err;
        }),
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiProvider({ apiKey: "test-fake-key", client: mockClient });
    await expect(
      provider.execute({ model: "gemini-3.5-flash", messages: [] }, { ...testContext, signal: controller.signal }),
    ).rejects.toMatchObject({
      errorClass: "TIMEOUT",
      code: "PROVIDER_TIMEOUT",
    });
  });

  it("rejects malformed function calls without a name as PERMANENT MALFORMED_PROVIDER_RESPONSE", async () => {
    const mockClient = {
      models: {
        generateContent: vi.fn(async () => ({
          functionCalls: [{ name: "" }],
        })),
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiProvider({ apiKey: "test-fake-key", client: mockClient });
    await expect(
      provider.execute({ model: "gemini-3.5-flash", messages: [] }, testContext),
    ).rejects.toMatchObject({
      errorClass: "PERMANENT",
      code: "MALFORMED_PROVIDER_RESPONSE",
    });
  });
});
