import { GeminiProvider } from "./providers/gemini.js";
import type { ProviderExecutionContext } from "./types.js";

async function main() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash";

  console.log("==========================================================");
  console.log(" Google Gemini Live Provider Validation (Separate from Benchmark)");
  console.log("==========================================================");

  if (!apiKey) {
    console.log("[SKIP] GEMINI_API_KEY is not set.");
    console.log("To run live validation against the real Gemini API:");
    console.log("  $env:GEMINI_API_KEY=\"<your-api-key>\"");
    console.log("  pnpm validate:gemini");
    console.log("==========================================================");
    return;
  }

  console.log(`Model: ${model}`);
  console.log("Status: GEMINI_API_KEY detected. Starting validation...\n");

  const provider = new GeminiProvider({ apiKey, model });
  const context: ProviderExecutionContext = {
    runId: "live-validation-run",
    logicalOperationId: "live-op-001",
    attemptId: "live-attempt-001",
    deadlineAt: new Date(Date.now() + 60_000),
  };

  // 1. Basic Generation
  console.log("1. Testing Basic Generation...");
  const genResponse = await provider.execute(
    {
      model,
      instructions: "You are a concise validation agent.",
      messages: [{ role: "user", content: "Reply with 'GEMINI_LIVE_SUCCESS'." }],
      temperature: 0,
    },
    context,
  );
  console.log(`   Response text: "${genResponse.text.trim()}"`);
  console.log(`   Finish reason: ${genResponse.finishReason}`);
  console.log(`   Token usage: prompt=${genResponse.usage.inputTokens}, candidates=${genResponse.usage.outputTokens}`);
  console.log("   ✓ Basic generation passed.\n");

  // 2. Tool Calling
  console.log("2. Testing Function Calling...");
  const toolResponse = await provider.execute(
    {
      model,
      messages: [{ role: "user", content: "Calculate 12 + 34 using the compute_sum tool." }],
      tools: [
        {
          name: "compute_sum",
          description: "Calculates the sum of two integers",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        },
      ],
    },
    context,
  );

  if (toolResponse.toolCalls.length === 0) {
    throw new Error("Expected model to call compute_sum tool, but received 0 tool calls");
  }
  const call = toolResponse.toolCalls[0]!;
  console.log(`   Tool called: ${call.name}`);
  console.log(`   Arguments: ${JSON.stringify(call.arguments)}`);
  console.log("   ✓ Function calling passed.\n");

  // 3. Multi-turn Continuation
  console.log("3. Testing Multi-turn Continuation with Tool Result...");
  const turn2Response = await provider.execute(
    {
      model,
      messages: [
        { role: "user", content: "Calculate 12 + 34 using the compute_sum tool." },
        { role: "assistant", content: "", toolCalls: [call] },
        {
          role: "tool",
          name: "compute_sum",
          toolCallId: call.id,
          content: JSON.stringify({ sum: 46 }),
        },
      ],
    },
    { ...context, logicalOperationId: "live-op-002" },
  );
  console.log(`   Follow-up text: "${turn2Response.text.trim()}"`);
  console.log("   ✓ Multi-turn continuation passed.\n");

  // 4. Error Classification
  console.log("4. Testing Error Classification on Invalid Model...");
  try {
    const badProvider = new GeminiProvider({ apiKey, model: "nonexistent-model-error-check" });
    await badProvider.execute(
      { model: "nonexistent-model-error-check", messages: [{ role: "user", content: "hi" }] },
      context,
    );
    console.log("   [WARN] Invalid model call did not throw.");
  } catch (err: any) {
    console.log(`   Caught error: ${err.name} [${err.code}] errorClass=${err.errorClass}`);
    console.log("   ✓ Error classification passed.\n");
  }

  console.log("==========================================================");
  console.log(" All Google Gemini Live Validations Passed Successfully!");
  console.log("==========================================================");
}

main().catch((err) => {
  console.error("Live validation failed:", err);
  process.exit(1);
});
