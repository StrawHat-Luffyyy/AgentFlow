import { GroqProvider, ProviderError, groqDefaultModel, type ProviderExecutionContext } from "@agentflow/harness";
import { describe, expect, it } from "vitest";

if (!process.env.GROQ_API_KEY) {
  try {
    process.loadEnvFile?.();
  } catch {
    // ignore if .env is missing
  }
}

const hasGroqKey = Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim().length > 0);
const groqModel = process.env.GROQ_MODEL || groqDefaultModel;

const liveContext: ProviderExecutionContext = {
  runId: "groq-live-run-001",
  logicalOperationId: "groq-live-op-001",
  attemptId: "groq-live-attempt-001",
  deadlineAt: new Date(Date.now() + 60_000),
};

const computeSum = {
  name: "compute_sum",
  description: "Calculates the sum of two integers",
  inputSchema: {
    type: "object" as const,
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
};

describe.skipIf(!hasGroqKey)("Groq Live Provider Validation (Opt-In)", () => {
  it("generates text and reports provider usage with provenance 'reported'", async () => {
    const provider = new GroqProvider({ apiKey: process.env.GROQ_API_KEY, model: groqModel });
    const response = await provider.execute(
      {
        model: groqModel,
        instructions: "You are a concise test assistant. Always follow output instructions precisely.",
        messages: [{ role: "user", content: "Reply with the single exact phrase: 'AGENTFLOW_GROQ_LIVE_OK'." }],
        temperature: 0,
      },
      liveContext,
    );
    expect(response.text).toContain("AGENTFLOW_GROQ_LIVE_OK");
    expect(response.finishReason).toBe("stop");
    expect(response.usage.provenance).toBe("reported");
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBeGreaterThan(0);
    expect(response.usage.totalTokens).toBe(response.usage.inputTokens! + response.usage.outputTokens!);
    expect(response.providerRequestId).toBeTruthy();
  }, 30_000);

  it("calls a tool and continues with the tool result", async () => {
    const provider = new GroqProvider({ apiKey: process.env.GROQ_API_KEY, model: groqModel });
    const first = await provider.execute(
      {
        model: groqModel,
        messages: [{ role: "user", content: "What is 15 plus 27? Call the compute_sum tool to find out." }],
        tools: [computeSum],
      },
      liveContext,
    );
    expect(first.finishReason).toBe("tool_calls");
    const call = first.toolCalls[0]!;
    expect(call.name).toBe("compute_sum");

    const second = await provider.execute(
      {
        model: groqModel,
        messages: [
          { role: "user", content: "What is 15 plus 27? Call the compute_sum tool to find out." },
          { role: "assistant", content: "", toolCalls: [call] },
          { role: "tool", name: "compute_sum", toolCallId: call.id, content: JSON.stringify({ sum: 42 }) },
        ],
        tools: [computeSum],
      },
      { ...liveContext, logicalOperationId: "groq-live-op-002" },
    );
    expect(second.text).toContain("42");
  }, 60_000);

  it("classifies an unknown model as a permanent error", async () => {
    const provider = new GroqProvider({ apiKey: process.env.GROQ_API_KEY, model: groqModel });
    const failure = await provider
      .execute({ model: "nonexistent-model-error-check", messages: [{ role: "user", content: "hi" }] }, liveContext)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).errorClass).toBe("PERMANENT");
  }, 30_000);
});
