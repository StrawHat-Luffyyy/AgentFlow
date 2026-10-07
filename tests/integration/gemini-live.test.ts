import { GeminiProvider, type ProviderExecutionContext } from "@agentflow/harness";
import { describe, expect, it } from "vitest";

const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
const geminiModel = process.env.GEMINI_MODEL || "gemini-3.5-flash";

const liveContext: ProviderExecutionContext = {
  runId: "live-validation-run-001",
  logicalOperationId: "live-op-001",
  attemptId: "live-attempt-001",
  deadlineAt: new Date(Date.now() + 60_000),
};

describe.skipIf(!hasGeminiKey)("Google Gemini Live Provider Validation (Opt-In)", () => {
  it("executes basic text generation and extracts normalized token usage with gemini-3.5-flash", async () => {
    const provider = new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY,
      model: geminiModel,
    });

    const response = await provider.execute(
      {
        model: geminiModel,
        instructions: "You are a concise test assistant. Always follow output instructions precisely.",
        messages: [{ role: "user", content: "Reply with the single exact phrase: 'AGENTFLOW_GEMINI_LIVE_OK'." }],
        temperature: 0,
      },
      liveContext,
    );

    expect(response.text).toContain("AGENTFLOW_GEMINI_LIVE_OK");
    expect(response.finishReason).toBe("stop");
    expect(response.usage.provenance).toBe("reported");
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBeGreaterThan(0);
    expect(response.opaqueState?.namespace).toBe("gemini.generateContent");
  }, 30_000);

  it("handles tool calling and multi-turn continuation with functionResponse", async () => {
    const provider = new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY,
      model: geminiModel,
    });

    // Turn 1: Trigger function call
    const turn1Response = await provider.execute(
      {
        model: geminiModel,
        messages: [{ role: "user", content: "What is 15 plus 27? Call the compute_sum tool to find out." }],
        tools: [
          {
            name: "compute_sum",
            description: "Adds two numbers together",
            inputSchema: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } },
              required: ["a", "b"],
            },
          },
        ],
      },
      liveContext,
    );

    expect(turn1Response.finishReason).toBe("tool_calls");
    expect(turn1Response.toolCalls).toHaveLength(1);
    expect(turn1Response.toolCalls[0]?.name).toBe("compute_sum");
    const call = turn1Response.toolCalls[0]!;
    expect(call.arguments).toMatchObject({ a: 15, b: 27 });

    // Turn 2: Feed tool result back as multi-turn continuation
    const turn2Response = await provider.execute(
      {
        model: geminiModel,
        messages: [
          { role: "user", content: "What is 15 plus 27? Call the compute_sum tool to find out." },
          { role: "assistant", content: "", toolCalls: [call] },
          {
            role: "tool",
            name: "compute_sum",
            toolCallId: call.id,
            content: JSON.stringify({ sum: 42 }),
          },
        ],
      },
      { ...liveContext, logicalOperationId: "live-op-002" },
    );

    expect(turn2Response.finishReason).toBe("stop");
    expect(turn2Response.text).toContain("42");
    expect(turn2Response.usage.inputTokens).toBeGreaterThan(0);
  }, 30_000);

  it("classifies invalid model requests as PERMANENT provider error", async () => {
    const provider = new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY,
      model: "invalid-nonexistent-model-xyz",
    });

    await expect(
      provider.execute(
        {
          model: "invalid-nonexistent-model-xyz",
          messages: [{ role: "user", content: "ping" }],
        },
        liveContext,
      ),
    ).rejects.toMatchObject({
      errorClass: "PERMANENT",
    });
  }, 30_000);
});
