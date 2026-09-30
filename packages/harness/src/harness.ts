import { TurnLimitError, HarnessValidationError } from "./errors.js";
import { ProviderRegistry, ToolRegistry } from "./registry.js";
import type {
  LLMRequest,
  LLMResponse,
  NormalizedToolCall,
  ProviderExecutionContext,
  ToolExecutionResult,
} from "./types.js";

export interface ModelOperationInput {
  provider: string;
  request: Omit<LLMRequest, "tools">;
  allowedTools: readonly string[];
  turn: number;
  maxTurns: number;
  context: ProviderExecutionContext;
}

export interface ToolOperationInput {
  call: NormalizedToolCall;
  allowedTools: readonly string[];
  context: ProviderExecutionContext;
}

export class AgentHarness {
  constructor(
    readonly providers: ProviderRegistry,
    readonly tools: ToolRegistry,
  ) {}

  async executeModelOperation(input: ModelOperationInput): Promise<LLMResponse> {
    if (!Number.isInteger(input.turn) || input.turn < 1) {
      throw new HarnessValidationError("Agent turn must be a positive integer", "INVALID_AGENT_TURN");
    }
    if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1) {
      throw new HarnessValidationError("maxTurns must be a positive integer", "INVALID_MAX_TURNS");
    }
    if (input.turn > input.maxTurns) throw new TurnLimitError(input.turn, input.maxTurns);
    if (input.context.deadlineAt.getTime() <= Date.now()) {
      throw new HarnessValidationError("Logical operation deadline has expired", "OPERATION_DEADLINE_EXPIRED");
    }

    const provider = this.providers.get(input.provider);
    if (input.allowedTools.length > 0 && !provider.capabilities.toolCalls) {
      throw new HarnessValidationError(
        `Provider ${provider.name} does not support tool calls`,
        "PROVIDER_CAPABILITY_MISMATCH",
      );
    }
    const response = await provider.execute(
      { ...input.request, tools: this.tools.providerTools(input.allowedTools) },
      input.context,
    );
    if (response.toolCalls.length > 1) {
      throw new HarnessValidationError(
        "Bounded agent turns support at most one tool call",
        "MULTIPLE_TOOL_CALLS_UNSUPPORTED",
      );
    }
    const seenCallIds = new Set<string>();
    const toolCalls = response.toolCalls.map((call) => {
      if (seenCallIds.has(call.id)) {
        throw new HarnessValidationError(`Duplicate provider tool-call id: ${call.id}`, "DUPLICATE_TOOL_CALL_ID");
      }
      seenCallIds.add(call.id);
      return this.tools.validateCall(call, input.allowedTools);
    });
    if (toolCalls.length > 0 && response.finishReason !== "tool_calls") {
      throw new HarnessValidationError(
        "Provider returned tool calls without a tool-call finish reason",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    return { ...response, toolCalls };
  }

  executeToolOperation(input: ToolOperationInput): Promise<ToolExecutionResult> {
    return this.tools.execute(input.call, input.allowedTools, {
      ...input.context,
      toolCallId: input.call.id,
    });
  }
}
