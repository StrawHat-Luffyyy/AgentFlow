import type { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface ProviderCapabilities {
  toolCalls: boolean;
  structuredOutput: boolean;
  streaming: boolean;
  contentTypes: readonly string[];
  cancellation: boolean;
  serverSideState: boolean;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface LLMMessage {
  role: MessageRole;
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: NormalizedToolCall[];
}

export interface ProviderTool {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  instructions?: string;
  tools?: ProviderTool[];
  maxOutputTokens?: number;
  temperature?: number;
  opaqueState?: JsonObject;
}

export interface ProviderExecutionContext {
  runId: string;
  logicalOperationId: string;
  attemptId: string;
  deadlineAt: Date;
  signal?: AbortSignal;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error" | "unknown";
export type UsageProvenance = "reported" | "estimated" | "unknown";

export interface LLMUsage {
  provenance: UsageProvenance;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  raw: JsonObject;
}

export interface LLMResponse {
  text: string;
  toolCalls: NormalizedToolCall[];
  finishReason: FinishReason;
  usage: LLMUsage;
  providerRequestId: string | null;
  resolvedModel: string;
  opaqueState: JsonObject | null;
}

export interface LLMProvider {
  readonly name: string;
  readonly adapterVersion: string;
  readonly capabilities: ProviderCapabilities;
  execute(request: LLMRequest, context: ProviderExecutionContext): Promise<LLMResponse>;
}

export interface ToolExecutionContext extends ProviderExecutionContext {
  toolCallId: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  version: string;
  description: string;
  effectClass: "PURE" | "REPEATABLE_READ";
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  providerSchema: JsonSchemaObject;
  validateTarget?: (input: TInput, context: ToolExecutionContext) => void | Promise<void>;
  execute: (input: TInput, context: ToolExecutionContext) => TOutput | Promise<TOutput>;
}

export interface ToolExecutionResult {
  toolCallId: string;
  name: string;
  version: string;
  output: unknown;
}
