import { ProviderError } from "./errors.js";
import { GroqProvider, groqDefaultModel } from "./providers/groq.js";
import type { ProviderExecutionContext } from "./types.js";

// Live Groq validation, separate from the benchmark. Mirrors live-validate.ts (Gemini).
async function main() {
  if (!process.env.GROQ_API_KEY) {
    try {
      process.loadEnvFile?.();
    } catch {
      // ignore if .env is missing
    }
  }
  const apiKey = process.env.GROQ_API_KEY?.trim();
  const model = process.env.GROQ_MODEL?.trim() || groqDefaultModel;

  console.log("==========================================================");
  console.log(" Groq Live Provider Validation (Separate from Benchmark)");
  console.log("==========================================================");

  if (!apiKey) {
    console.log("[SKIP] GROQ_API_KEY is not set.");
    console.log("To run live validation against the real Groq API:");
    console.log("  $env:GROQ_API_KEY=\"<your-api-key>\"");
    console.log("  pnpm validate:groq");
    console.log("==========================================================");
    return;
  }

  console.log(`Model: ${model}`);
  console.log("Status: GROQ_API_KEY detected. Starting validation...\n");

  const provider = new GroqProvider({ apiKey, model });
  const context: ProviderExecutionContext = {
    runId: "live-validation-run",
    logicalOperationId: "live-op-001",
    attemptId: "live-attempt-001",
    deadlineAt: new Date(Date.now() + 60_000),
  };

  console.log("1. Testing Basic Generation...");
  const generation = await provider.execute(
    {
      model,
      instructions: "You are a concise validation agent.",
      messages: [{ role: "user", content: "Reply with 'GROQ_LIVE_SUCCESS'." }],
      temperature: 0,
    },
    context,
  );
  console.log(`   Response text: "${generation.text.trim()}"`);
  console.log(`   Finish reason: ${generation.finishReason}`);
  console.log(`   Resolved model: ${generation.resolvedModel}`);
  console.log(
    `   Usage (${generation.usage.provenance}): input=${generation.usage.inputTokens}` +
    ` cached=${generation.usage.cachedInputTokens} output=${generation.usage.outputTokens}` +
    ` reasoning=${generation.usage.reasoningTokens} total=${generation.usage.totalTokens}`,
  );
  console.log("   ✓ Basic generation passed.\n");

  console.log("2. Testing Function Calling...");
  const tools = [{
    name: "compute_sum",
    description: "Calculates the sum of two integers",
    inputSchema: {
      type: "object" as const,
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  }];
  const toolResponse = await provider.execute(
    { model, messages: [{ role: "user", content: "Calculate 12 + 34 using the compute_sum tool." }], tools },
    context,
  );
  const call = toolResponse.toolCalls[0];
  if (!call) throw new Error("Expected model to call compute_sum tool, but received 0 tool calls");
  console.log(`   Tool called: ${call.name} ${JSON.stringify(call.arguments)}`);
  console.log("   ✓ Function calling passed.\n");

  console.log("3. Testing Multi-turn Continuation with Tool Result...");
  const followUp = await provider.execute(
    {
      model,
      messages: [
        { role: "user", content: "Calculate 12 + 34 using the compute_sum tool." },
        { role: "assistant", content: "", toolCalls: [call] },
        { role: "tool", name: "compute_sum", toolCallId: call.id, content: JSON.stringify({ sum: 46 }) },
      ],
      tools,
    },
    { ...context, logicalOperationId: "live-op-002" },
  );
  console.log(`   Follow-up text: "${followUp.text.trim()}"`);
  console.log("   ✓ Multi-turn continuation passed.\n");

  console.log("4. Testing Error Classification on Invalid Model...");
  try {
    await provider.execute({ model: "nonexistent-model-error-check", messages: [{ role: "user", content: "hi" }] }, context);
    console.log("   [WARN] Invalid model call did not throw.");
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    console.log(`   Caught error: [${error.code}] errorClass=${error.errorClass}`);
    console.log("   ✓ Error classification passed.\n");
  }

  console.log("==========================================================");
  console.log(" All Groq Live Validations Passed Successfully!");
  console.log("==========================================================");
}

main().catch((error) => {
  console.error("Live validation failed:", error);
  process.exit(1);
});
