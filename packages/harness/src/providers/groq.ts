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
import { abortError, asJsonObject, asObject, nullableCount, parseRetryAfter, type FetchLike } from "./http.js";

// Groq OpenAI-compatible Chat Completions adapter (plain fetch, no SDK).
// Facts checked 2026-11-18 against console.groq.com/docs (models, tool-use,
// structured-outputs, prompt-caching, rate-limits, errors, api-reference, reasoning):
// - POST https://api.groq.com/openai/v1/chat/completions, `Authorization: Bearer <key>`.
// - Default model openai/gpt-oss-120b: a production model with tool calling and strict
//   json_schema structured outputs. Structured outputs cannot be combined with tool use
//   in one request, so that combination is rejected here as PERMANENT.
// - `max_completion_tokens` replaces the deprecated `max_tokens`.
// - usage: prompt_tokens, completion_tokens, total_tokens; prompt caching is automatic
//   for gpt-oss models and reports prompt_tokens_details.cached_tokens (part of
//   prompt_tokens). The docs do not state whether reasoning tokens are counted inside
//   completion_tokens; this adapter follows the OpenAI convention (completion_tokens
//   includes reasoning) and records completion_tokens_details.reasoning_tokens only
//   when the API returns it.
// - Errors: 429 (retry-after seconds), 498 (flex capacity), and 5xx are transient;
//   400/401/403/404/413/422 are permanent. Error body: {"error":{"message","type"}}.

const capabilities: ProviderCapabilities = {
  toolCalls: true,
  structuredOutput: true,
  streaming: false,
  contentTypes: ["text"],
  cancellation: true,
  serverSideState: false,
};

export const groqDefaultModel = "openai/gpt-oss-120b";
const defaultBaseUrl = "https://api.groq.com/openai/v1";

export interface GroqProviderOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  fetch?: FetchLike | undefined;
}

interface GroqToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type GroqMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: GroqToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

function toGroqMessages(request: LLMRequest): GroqMessage[] {
  const messages: GroqMessage[] = [];
  if (request.instructions) messages.push({ role: "system", content: request.instructions });
  for (const message of request.messages) {
    if (message.role === "tool") {
      if (!message.toolCallId) {
        throw new ProviderError("Tool result message has no toolCallId", "PERMANENT", "GROQ_INVALID_TOOL_RESULT");
      }
      messages.push({
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
        ...(message.name ? { name: message.name } : {}),
      });
    } else if (message.role === "assistant") {
      const toolCalls = (message.toolCalls ?? []).map((call): GroqToolCall => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }));
      messages.push({
        role: "assistant",
        content: message.content || (toolCalls.length > 0 ? null : ""),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      messages.push({ role: message.role, content: message.content });
    }
  }
  return messages;
}

async function groqHttpError(response: Response): Promise<ProviderError> {
  let detail = "";
  try {
    const text = (await response.text()).slice(0, 2_000);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown; type?: unknown } };
      detail = typeof parsed.error?.message === "string" ? parsed.error.message : text;
    } catch {
      detail = text;
    }
  } catch {
    detail = "";
  }
  const status = response.status;
  const transient = status === 408 || status === 429 || status === 498 || status >= 500;
  return new ProviderError(
    `Groq request failed with HTTP ${status}${detail ? `: ${detail}` : ""}`,
    transient ? "TRANSIENT" : "PERMANENT",
    `GROQ_HTTP_${status}`,
    status,
    parseRetryAfter(response.headers.get("retry-after")),
  );
}

function mapFinishReason(raw: unknown, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return "tool_calls";
  if (raw === "stop") return "stop";
  if (raw === "length") return "length";
  if (raw === "content_filter") return "content_filter";
  if (raw === "tool_calls") return "tool_calls";
  return "unknown";
}

function parseToolCalls(raw: unknown): NormalizedToolCall[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ProviderError("Groq tool_calls was not an array", "PERMANENT", "MALFORMED_PROVIDER_RESPONSE");
  }
  return raw.map((entry) => {
    const call = asObject(entry, "Groq tool call");
    const fn = asObject(call.function, "Groq tool call function");
    if (typeof call.id !== "string" || !call.id || typeof fn.name !== "string" || !fn.name) {
      throw new ProviderError("Groq returned a tool call without an id or name", "PERMANENT", "MALFORMED_PROVIDER_RESPONSE");
    }
    let args: unknown = {};
    if (typeof fn.arguments === "string" && fn.arguments.trim() !== "") {
      try {
        args = JSON.parse(fn.arguments);
      } catch (error) {
        throw new ProviderError(
          `Groq tool call ${fn.name} had non-JSON arguments`,
          "PERMANENT",
          "MALFORMED_PROVIDER_RESPONSE",
          null,
          null,
          false,
          { cause: error },
        );
      }
    } else if (fn.arguments !== undefined && typeof fn.arguments !== "string") {
      args = fn.arguments;
    }
    return { id: call.id, name: fn.name, arguments: asJsonObject(args, "Groq tool call arguments") };
  });
}

export class GroqProvider implements LLMProvider {
  readonly name = "groq";
  readonly adapterVersion = "1.0.0";
  readonly capabilities = capabilities;
  readonly defaultModel: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(options: GroqProviderOptions = {}) {
    const apiKey = options.apiKey || process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("Groq API key is required (pass apiKey or set GROQ_API_KEY)");
    this.#apiKey = apiKey;
    this.defaultModel = options.model ?? groqDefaultModel;
    this.#baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
  }

  async execute(request: LLMRequest, context: ProviderExecutionContext): Promise<LLMResponse> {
    const model = request.model || this.defaultModel;
    const tools = request.tools ?? [];
    const responseSchema = request.opaqueState?.responseSchema;
    if (responseSchema !== undefined && tools.length > 0) {
      throw new ProviderError(
        "Groq does not support structured outputs together with tool use in one request",
        "PERMANENT",
        "GROQ_STRUCTURED_OUTPUT_WITH_TOOLS_UNSUPPORTED",
      );
    }
    const body: Record<string, unknown> = {
      model,
      messages: toGroqMessages(request),
      ...(request.maxOutputTokens === undefined ? {} : { max_completion_tokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
    };
    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }));
      // The harness accepts at most one tool call per bounded turn.
      body.parallel_tool_calls = false;
    }
    if (responseSchema !== undefined) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "agentflow_response", schema: responseSchema, strict: true },
      };
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      throw abortError("Groq", error, context.signal);
    }
    if (!response.ok) throw await groqHttpError(response);

    let payload: Record<string, unknown>;
    try {
      payload = asObject(await response.json(), "Groq response");
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      // The provider produced (and may bill) a response we could not read.
      throw new ProviderError("Groq returned a non-JSON response", "TRANSIENT", "MALFORMED_PROVIDER_RESPONSE", null, null, true, { cause: error });
    }
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const choice = choices.length > 0 ? asObject(choices[0], "Groq choice") : null;
    if (!choice) throw new ProviderError("Groq response had no choices", "PERMANENT", "MALFORMED_PROVIDER_RESPONSE");
    const message = asObject(choice.message, "Groq message");
    const toolCalls = parseToolCalls(message.tool_calls);

    const usageRaw = payload.usage === undefined || payload.usage === null ? null : asObject(payload.usage, "Groq usage");
    const promptDetails = usageRaw?.prompt_tokens_details;
    const completionDetails = usageRaw?.completion_tokens_details;
    const usage = {
      provenance: usageRaw ? ("reported" as const) : ("unknown" as const),
      inputTokens: nullableCount(usageRaw?.prompt_tokens),
      outputTokens: nullableCount(usageRaw?.completion_tokens),
      cachedInputTokens: promptDetails && typeof promptDetails === "object"
        ? nullableCount((promptDetails as Record<string, unknown>).cached_tokens)
        : null,
      reasoningTokens: completionDetails && typeof completionDetails === "object"
        ? nullableCount((completionDetails as Record<string, unknown>).reasoning_tokens)
        : null,
      totalTokens: nullableCount(usageRaw?.total_tokens),
      raw: usageRaw ? asJsonObject(usageRaw, "Groq usage") : ({} as JsonObject),
    };

    const xGroq = payload.x_groq && typeof payload.x_groq === "object" ? payload.x_groq as Record<string, unknown> : null;
    const requestId = typeof xGroq?.id === "string" ? xGroq.id : typeof payload.id === "string" ? payload.id : null;
    return {
      text: typeof message.content === "string" ? message.content : "",
      toolCalls,
      finishReason: mapFinishReason(choice.finish_reason, toolCalls.length > 0),
      usage,
      providerRequestId: requestId,
      resolvedModel: typeof payload.model === "string" && payload.model ? payload.model : model,
      opaqueState: null,
    };
  }
}
