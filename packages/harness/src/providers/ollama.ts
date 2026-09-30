import { ProviderError } from "../errors.js";
import type {
  JsonObject,
  LLMMessage,
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
  structuredOutput: false,
  streaming: false,
  contentTypes: ["text"],
  cancellation: true,
  serverSideState: false,
};

export interface OllamaProviderOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  apiKey?: string;
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  readonly adapterVersion = "1.0.0";
  readonly capabilities = capabilities;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;

  constructor(private readonly options: OllamaProviderOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = (options.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
  }

  async execute(request: LLMRequest, context: ProviderExecutionContext): Promise<LLMResponse> {
    const messages: LLMMessage[] = request.instructions
      ? [{ role: "system", content: request.instructions }, ...request.messages]
      : request.messages;
    const body: Record<string, unknown> = {
      model: request.model,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.name ? { tool_name: message.name } : {}),
        ...(message.toolCalls && message.toolCalls.length > 0 ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            function: { name: call.name, arguments: call.arguments },
          })),
        } : {}),
      })),
      stream: false,
      options: {
        ...(request.maxOutputTokens !== undefined ? { num_predict: request.maxOutputTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      },
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-agentflow-operation-id": context.logicalOperationId,
    };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;

    let response: Response;
    try {
      const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body) };
      if (context.signal) init.signal = context.signal;
      response = await this.#fetch(`${this.#baseUrl}/api/chat`, init);
    } catch (error) {
      throw abortError("Ollama", error, context.signal);
    }
    if (!response.ok) throw await providerHttpError("ollama", response);

    let data: Record<string, unknown>;
    try {
      data = asObject(await response.json(), "Ollama response");
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("Ollama returned invalid JSON", "PERMANENT", "MALFORMED_PROVIDER_RESPONSE", response.status, null, false, { cause: error });
    }
    const message = asObject(data.message, "Ollama message");
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls: NormalizedToolCall[] = rawCalls.map((rawCall, index) => {
      const call = asObject(rawCall, "Ollama tool call");
      const fn = asObject(call.function, "Ollama tool function");
      if (typeof fn.name !== "string") {
        throw new ProviderError("Ollama returned a tool call without a name", "PERMANENT", "MALFORMED_PROVIDER_RESPONSE");
      }
      let args: unknown = fn.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch (error) {
          throw new ProviderError("Ollama returned malformed tool arguments", "PERMANENT", "MALFORMED_TOOL_ARGUMENTS", null, null, false, { cause: error });
        }
      }
      return {
        id: typeof call.id === "string" ? call.id : `ollama-tool-${context.logicalOperationId}-${index}`,
        name: fn.name,
        arguments: asJsonObject(args, "Ollama tool arguments"),
      };
    });
    let opaqueState: JsonObject | null = null;
    if (Array.isArray(data.context)) {
      opaqueState = { namespace: "ollama.chat", version: 1, context: data.context as number[] };
    }
    return {
      text: typeof message.content === "string" ? message.content : "",
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool_calls" : data.done === true ? "stop" : "unknown",
      usage: {
        provenance: data.prompt_eval_count === undefined && data.eval_count === undefined ? "unknown" : "reported",
        inputTokens: nullableCount(data.prompt_eval_count),
        outputTokens: nullableCount(data.eval_count),
        cachedInputTokens: null,
        reasoningTokens: null,
        raw: {
          promptEvalCount: nullableCount(data.prompt_eval_count),
          evalCount: nullableCount(data.eval_count),
          promptEvalDuration: nullableCount(data.prompt_eval_duration),
          evalDuration: nullableCount(data.eval_duration),
        },
      },
      providerRequestId: response.headers.get("x-request-id"),
      resolvedModel: typeof data.model === "string" ? data.model : request.model,
      opaqueState,
    };
  }
}
