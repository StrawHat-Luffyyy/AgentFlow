import { ApiError, GoogleGenAI, type Content, type GenerateContentConfig, type GenerateContentResponse, type Part } from "@google/genai";
import { ProviderError } from "../errors.js";
import type {
  FinishReason,
  JsonObject,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  NormalizedToolCall,
  ProviderCapabilities,
  ProviderExecutionContext,
} from "../types.js";
import { asJsonObject, nullableCount } from "./http.js";

const capabilities: ProviderCapabilities = {
  toolCalls: true,
  structuredOutput: true,
  streaming: false,
  contentTypes: ["text"],
  cancellation: true,
  serverSideState: true,
};

export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
  client?: GoogleGenAI;
  baseUrl?: string;
}

function classifyGeminiError(error: unknown, signal: AbortSignal | undefined): ProviderError {
  const timedOut = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
  if (timedOut) {
    return new ProviderError(
      "Gemini request timed out or was aborted",
      "TIMEOUT",
      "PROVIDER_TIMEOUT",
      null,
      null,
      true,
      { cause: error },
    );
  }

  if (error instanceof ProviderError) return error;

  if (error instanceof ApiError) {
    const status = error.status ?? null;
    const retryable = status === 408 || status === 409 || status === 429 || (status !== null && status >= 500);
    const code = status !== null ? `GEMINI_HTTP_${status}` : "GEMINI_API_ERROR";
    return new ProviderError(
      error.message || `Gemini API request failed with status ${status}`,
      retryable ? "TRANSIENT" : "PERMANENT",
      code,
      status,
      null,
      false,
      { cause: error },
    );
  }

  const message = error instanceof Error ? error.message : String(error);

  if (/RESOURCE_EXHAUSTED|rate[ -]?limit|quota/i.test(message)) {
    return new ProviderError(message, "TRANSIENT", "GEMINI_RESOURCE_EXHAUSTED", 429, null, false, { cause: error });
  }

  if (/UNAVAILABLE|temporarily unavailable|overloaded/i.test(message)) {
    return new ProviderError(message, "TRANSIENT", "GEMINI_UNAVAILABLE", 503, null, false, { cause: error });
  }

  if (/DEADLINE_EXCEEDED|timeout/i.test(message)) {
    return new ProviderError(message, "TIMEOUT", "GEMINI_DEADLINE_EXCEEDED", 504, null, true, { cause: error });
  }

  if (/INVALID_ARGUMENT|API_KEY_INVALID|PERMISSION_DENIED|unauthenticated/i.test(message)) {
    return new ProviderError(message, "PERMANENT", "GEMINI_INVALID_ARGUMENT", 400, null, false, { cause: error });
  }

  return new ProviderError(
    `Gemini request failed: ${message}`,
    "TRANSIENT",
    "GEMINI_NETWORK_ERROR",
    null,
    null,
    true,
    { cause: error },
  );
}

function mapMessagesToContents(messages: readonly LLMMessage[]): Content[] {
  const contents: Content[] = [];

  for (const message of messages) {
    const parts: Part[] = [];

    if (message.role === "tool") {
      let outputPayload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(message.content);
        outputPayload = typeof parsed === "object" && parsed !== null ? parsed : { output: message.content };
      } catch {
        outputPayload = { output: message.content };
      }

      parts.push({
        functionResponse: {
          name: message.name ?? "tool_result",
          response: outputPayload,
        },
      });
      contents.push({ role: "user", parts });
      continue;
    }

    if (message.content) {
      parts.push({ text: message.content });
    }

    for (const call of message.toolCalls ?? []) {
      parts.push({
        functionCall: {
          name: call.name,
          args: call.arguments,
        },
      });
    }

    const role = message.role === "assistant" ? "model" : "user";
    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  return contents;
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly adapterVersion = "1.0.0";
  readonly capabilities = capabilities;
  readonly defaultModel: string;
  readonly #client: GoogleGenAI;

  constructor(private readonly options: GeminiProviderOptions = {}) {
    this.defaultModel = options.model ?? "gemini-3.5-flash";
    if (options.client) {
      this.#client = options.client;
    } else {
      const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("Gemini API key is required (pass apiKey or set GEMINI_API_KEY)");
      }
      this.#client = new GoogleGenAI({
        apiKey,
        ...(options.baseUrl ? { endpoint: options.baseUrl } : {}),
      });
    }
  }

  async execute(request: LLMRequest, context: ProviderExecutionContext): Promise<LLMResponse> {
    const model = request.model || this.defaultModel;
    const contents = mapMessagesToContents(request.messages);

    const config: GenerateContentConfig = {};

    if (request.instructions) {
      config.systemInstruction = request.instructions;
    }

    if (request.maxOutputTokens !== undefined) {
      config.maxOutputTokens = request.maxOutputTokens;
    }

    if (request.temperature !== undefined) {
      config.temperature = request.temperature;
    }

    if (context.signal) {
      config.abortSignal = context.signal;
    }

    if (request.tools && request.tools.length > 0) {
      config.tools = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema as Record<string, unknown>,
          })),
        },
      ];
    }

    if (request.opaqueState?.responseSchema) {
      config.responseMimeType = "application/json";
      config.responseSchema = request.opaqueState.responseSchema as Record<string, unknown>;
    }

    let response: GenerateContentResponse;
    try {
      response = await this.#client.models.generateContent({
        model,
        contents,
        config,
      });
    } catch (error) {
      throw classifyGeminiError(error, context.signal);
    }

    const toolCalls: NormalizedToolCall[] = [];
    const rawFunctionCalls = response.functionCalls ?? [];
    for (let index = 0; index < rawFunctionCalls.length; index++) {
      const call = rawFunctionCalls[index];
      if (!call || typeof call.name !== "string" || !call.name) {
        throw new ProviderError(
          "Gemini returned a function call without a valid name",
          "PERMANENT",
          "MALFORMED_PROVIDER_RESPONSE",
        );
      }
      toolCalls.push({
        id: call.id ?? `gemini-call-${context.logicalOperationId}-${index}`,
        name: call.name,
        arguments: asJsonObject(call.args ?? {}, "Gemini function call arguments"),
      });
    }

    let text = "";
    try {
      text = response.text ?? "";
    } catch {
      text = "";
    }

    const candidate = response.candidates?.[0];
    const rawFinishReason = candidate?.finishReason;
    let finishReason: FinishReason;
    if (toolCalls.length > 0) {
      finishReason = "tool_calls";
    } else if (rawFinishReason === "STOP") {
      finishReason = "stop";
    } else if (rawFinishReason === "MAX_TOKENS") {
      finishReason = "length";
    } else if (rawFinishReason === "SAFETY" || rawFinishReason === "RECITATION") {
      finishReason = "content_filter";
    } else {
      finishReason = text.length > 0 ? "stop" : "unknown";
    }

    const usageMeta = response.usageMetadata;
    const usage = {
      provenance: usageMeta ? ("reported" as const) : ("unknown" as const),
      inputTokens: nullableCount(usageMeta?.promptTokenCount),
      outputTokens: nullableCount(usageMeta?.candidatesTokenCount),
      cachedInputTokens: nullableCount(usageMeta?.cachedContentTokenCount),
      reasoningTokens: null,
      raw: asJsonObject(usageMeta ?? {}, "Gemini usage metadata"),
    };

    const responseId = response.responseId ?? null;

    return {
      text,
      toolCalls,
      finishReason,
      usage,
      providerRequestId: responseId,
      resolvedModel: response.modelVersion ?? model,
      opaqueState: {
        namespace: "gemini.generateContent",
        version: 1,
        consumedMessages: request.messages.length + 1,
      },
    };
  }
}
