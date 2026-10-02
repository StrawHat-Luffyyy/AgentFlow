import {
  AgentHarness,
  HarnessValidationError,
  ProviderError,
  type JsonObject,
  type LLMMessage,
  type LLMResponse,
} from "@agentflow/harness";
import type { Database } from "@agentflow/db";
import {
  AttemptTimeoutError,
  PermanentOperationError,
  RetryableOperationError,
  beginHarnessLlmOperation,
  beginHarnessToolOperation,
  completeHarnessLlmOperation,
  completeHarnessToolOperation,
  failHarnessLlmOperation,
  recordUnacceptedHarnessLlmResponse,
  type ClaimedOperation,
  type ExecutionFaultHooks,
} from "@agentflow/runtime";

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  const serialized = JSON.parse(JSON.stringify(value)) as unknown;
  if (serialized === null || typeof serialized !== "object" || Array.isArray(serialized)) {
    throw new PermanentOperationError(`${label} must be a JSON object`, "INVALID_AGENT_VALUE");
  }
  return serialized as Record<string, unknown>;
}

function replayedResponse(value: Record<string, unknown>): LLMResponse {
  const response = value as unknown as LLMResponse;
  if (
    typeof response.text !== "string" || !Array.isArray(response.toolCalls) ||
    typeof response.finishReason !== "string" || response.usage === null ||
    typeof response.usage !== "object"
  ) {
    throw new PermanentOperationError("Persisted provider response is malformed", "INVALID_PERSISTED_PROVIDER_RESPONSE");
  }
  return response;
}

function mapHarnessError(error: unknown): Error {
  if (error instanceof ProviderError) {
    if (error.errorClass === "TIMEOUT") return new AttemptTimeoutError(error.message);
    if (error.errorClass === "TRANSIENT") {
      return new RetryableOperationError(error.message, error.code, error.retryAfterMs ?? undefined);
    }
    return new PermanentOperationError(error.message, error.code);
  }
  if (error instanceof HarnessValidationError) {
    return new PermanentOperationError(error.message, error.code);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export async function executeBoundedAgentOperation(
  database: Database,
  operation: ClaimedOperation,
  harness: AgentHarness,
  faultHooks?: ExecutionFaultHooks,
): Promise<Record<string, unknown>> {
  const config = operation.agentConfig;
  if (operation.kind !== "AGENT" || !config) {
    throw new PermanentOperationError("Operation has no bounded agent configuration", "INVALID_AGENT_OPERATION");
  }
  const messages: LLMMessage[] = [{ role: "user", content: JSON.stringify(operation.input) }];
  let opaqueState: JsonObject | undefined;

  for (let turn = 1; turn <= config.maxTurns; turn += 1) {
    const provider = harness.providers.get(config.provider);
    const request = {
      model: config.model,
      messages,
      instructions: config.instructions,
      ...(config.maxOutputTokens === undefined ? {} : { maxOutputTokens: config.maxOutputTokens }),
      ...(opaqueState === undefined ? {} : { opaqueState }),
    };
    const llm = await beginHarnessLlmOperation(database, operation, {
      ordinal: (turn - 1) * 2,
      turn,
      maxTurns: config.maxTurns,
      provider: provider.name,
      adapterVersion: provider.adapterVersion,
      model: config.model,
      request: jsonRecord(request, "Provider request"),
    });

    let response: LLMResponse;
    if (llm.replayed) {
      response = replayedResponse(llm.output);
      opaqueState = llm.continuationState as JsonObject | null ?? undefined;
    } else {
      const controller = new AbortController();
      const remainingMs = Math.max(0, operation.attemptDeadlineAt.getTime() - Date.now());
      const timer = setTimeout(() => controller.abort(), remainingMs);
      timer.unref();
      try {
        response = await harness.executeModelOperation({
          provider: config.provider,
          request,
          allowedTools: config.allowedTools,
          turn,
          maxTurns: config.maxTurns,
          context: {
            runId: operation.runId,
            logicalOperationId: llm.logicalOperationId,
            attemptId: operation.attemptId,
            deadlineAt: operation.attemptDeadlineAt,
            signal: controller.signal,
          },
        });
        await faultHooks?.hit("after-provider-response", operation);
      } catch (error) {
        const providerError = error instanceof ProviderError ? error : null;
        await failHarnessLlmOperation(database, operation, llm.providerCallId, {
          code: providerError?.code ?? (error instanceof HarnessValidationError ? error.code : "HARNESS_EXECUTION_ERROR"),
          message: error instanceof Error ? error.message : String(error),
          outcomeUnknown: providerError?.outcomeUnknown ?? false,
        });
        throw mapHarnessError(error);
      } finally {
        clearTimeout(timer);
      }
      const completion = {
        output: jsonRecord(response, "Provider response"),
        continuationState: response.opaqueState,
        providerRequestId: response.providerRequestId,
        resolvedModel: response.resolvedModel,
        finishReason: response.finishReason,
        usage: response.usage,
      };
      try {
        await completeHarnessLlmOperation(database, operation, llm.providerCallId, completion);
        opaqueState = response.opaqueState ?? undefined;
      } catch (error) {
        await recordUnacceptedHarnessLlmResponse(
          database,
          operation,
          llm.providerCallId,
          completion,
        );
        throw mapHarnessError(error);
      }
    }

    if (response.toolCalls.length === 0) {
      const agentResult = {
        content: response.text,
        finishReason: response.finishReason,
        provider: config.provider,
        model: response.resolvedModel,
        turns: turn,
      };
      return config.outputKey
        ? { ...operation.input, [config.outputKey]: agentResult }
        : agentResult;
    }
    if (turn === config.maxTurns) {
      throw new PermanentOperationError(
        "Agent requested a tool on its final permitted turn",
        "AGENT_TURN_LIMIT_EXHAUSTED",
      );
    }
    const call = response.toolCalls[0]!;
    const tool = await beginHarnessToolOperation(database, operation, {
      ordinal: (turn - 1) * 2 + 1,
      turn,
      maxTurns: config.maxTurns,
      request: jsonRecord(call, "Tool call"),
    });
    let toolOutput: Record<string, unknown>;
    if (tool.replayed) {
      toolOutput = tool.output;
    } else {
      const result = await harness.executeToolOperation({
        call,
        allowedTools: config.allowedTools,
        context: {
          runId: operation.runId,
          logicalOperationId: tool.logicalOperationId,
          attemptId: operation.attemptId,
          deadlineAt: operation.attemptDeadlineAt,
        },
      });
      toolOutput = jsonRecord({ result: result.output }, "Tool result");
      await completeHarnessToolOperation(database, operation, tool.harnessOperationId, toolOutput);
    }
    messages.push({ role: "assistant", content: response.text, toolCalls: [call] });
    messages.push({
      role: "tool",
      content: JSON.stringify(toolOutput.result),
      toolCallId: call.id,
      name: call.name,
    });
  }
  throw new PermanentOperationError("Agent turn budget was exhausted", "AGENT_TURN_LIMIT_EXHAUSTED");
}
