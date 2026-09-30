import { ProviderError } from "../errors.js";
import type {
  FinishReason,
  JsonObject,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  NormalizedToolCall,
  ProviderCapabilities,
  ProviderExecutionContext,
} from "../types.js";
import { abortError, asJsonObject, asObject, nullableCount, providerHttpError, type FetchLike } from "./http.js";

const capabilities: ProviderCapabilities = {
  toolCalls: true,
  structuredOutput: true,
  streaming: false,
  contentTypes: ["text"],
  cancellation: true,
  serverSideState: true,
};

export interface OpenAIResponsesProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  organization?: string;
  project?: string;
}

export class OpenAIResponsesProvider implements LLMProvider {
  readonly name = "openai";
  readonly adapterVersion = "1.0.0";
  readonly capabilities = capabilities;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;

  constructor(private readonly options: OpenAIResponsesProviderOptions) {
    if (!options.apiKey) throw new Error("OpenAI API key is required");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  }

  async execute(request: LLMRequest, context: ProviderExecutionContext): Promise<LLMResponse> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      "content-type": "application/json",
      "x-client-request-id": context.logicalOperationId,
    };
    if (this.options.organization) headers["openai-organization"] = this.options.organization;
    if (this.options.project) headers["openai-project"] = this.options.project;

    const previousResponseId = request.opaqueState?.namespace === "openai.responses" &&
      typeof request.opaqueState.previousResponseId === "string"
      ? request.opaqueState.previousResponseId
      : undefined;
    const consumedMessages = request.opaqueState?.consumedMessages;
    const inputMessages = previousResponseId && typeof consumedMessages === "number" &&
      Number.isInteger(consumedMessages) && consumedMessages >= 0
      ? request.messages.slice(consumedMessages)
      : request.messages;
    const body: Record<string, unknown> = {
      model: request.model,
      input: inputMessages.flatMap((message) => {
        if (message.role === "tool") {
          return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
        }
        const items: unknown[] = [];
        if (message.content) items.push({ role: message.role, content: message.content });
        for (const call of message.toolCalls ?? []) {
          items.push({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          });
        }
        return items;
      }),
      store: true,
    };
    if (request.instructions) body.instructions = request.instructions;
    if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (previousResponseId) {
      body.previous_response_id = previousResponseId;
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: true,
      }));
    }

    let response: Response;
    try {
      const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body) };
      if (context.signal) init.signal = context.signal;
      response = await this.#fetch(`${this.#baseUrl}/responses`, init);
    } catch (error) {
      throw abortError("OpenAI", error, context.signal);
    }
    if (!response.ok) throw await providerHttpError("openai", response);

    let data: Record<string, unknown>;
    try {
      data = asObject(await response.json(), "OpenAI response");
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("OpenAI returned invalid JSON", "PERMANENT", "MALFORMED_PROVIDER_RESPONSE", response.status, null, false, { cause: error });
    }
    const output = Array.isArray(data.output) ? data.output : [];
    const text: string[] = [];
    const toolCalls: NormalizedToolCall[] = [];
    for (const rawItem of output) {
      const item = asObject(rawItem, "OpenAI output item");
      if (item.type === "function_call") {
        if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string") {
          throw new ProviderError("OpenAI returned an invalid function call", "PERMANENT", "MALFORMED_PROVIDER_RESPONSE");
        }
        let args: unknown;
        try {
          args = JSON.parse(item.arguments);
        } catch (error) {
          throw new ProviderError("OpenAI returned malformed function arguments", "PERMANENT", "MALFORMED_TOOL_ARGUMENTS", null, null, false, { cause: error });
        }
        toolCalls.push({ id: item.call_id, name: item.name, arguments: asJsonObject(args, "OpenAI function arguments") });
      }
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const rawContent of item.content) {
          const content = asObject(rawContent, "OpenAI message content");
          if (content.type === "output_text" && typeof content.text === "string") text.push(content.text);
        }
      }
    }
    const usage = data.usage === undefined ? {} : asObject(data.usage, "OpenAI usage");
    const inputDetails = usage.input_tokens_details === undefined ? {} : asObject(usage.input_tokens_details, "OpenAI input token details");
    const outputDetails = usage.output_tokens_details === undefined ? {} : asObject(usage.output_tokens_details, "OpenAI output token details");
    const responseId = typeof data.id === "string" ? data.id : null;
    const finishReason: FinishReason = toolCalls.length > 0
      ? "tool_calls"
      : data.status === "incomplete"
        ? "length"
        : data.status === "completed" ? "stop" : "unknown";
    return {
      text: text.join("\n"),
      toolCalls,
      finishReason,
      usage: {
        provenance: data.usage === undefined ? "unknown" : "reported",
        inputTokens: nullableCount(usage.input_tokens),
        outputTokens: nullableCount(usage.output_tokens),
        cachedInputTokens: nullableCount(inputDetails.cached_tokens),
        reasoningTokens: nullableCount(outputDetails.reasoning_tokens),
        raw: asJsonObject(usage, "OpenAI usage"),
      },
      providerRequestId: response.headers.get("x-request-id") ?? responseId,
      resolvedModel: typeof data.model === "string" ? data.model : request.model,
      opaqueState: responseId === null ? null : {
        namespace: "openai.responses",
        version: 1,
        previousResponseId: responseId,
        consumedMessages: request.messages.length + 1,
      },
    };
  }
}
