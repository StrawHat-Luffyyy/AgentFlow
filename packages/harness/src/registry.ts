import { isIP } from "node:net";
import { z } from "zod";
import { HarnessValidationError } from "./errors.js";
import type {
  JsonObject,
  LLMProvider,
  NormalizedToolCall,
  ProviderTool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";

const toolName = z.string().min(1).max(128).regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/);

export class ProviderRegistry {
  readonly #providers = new Map<string, LLMProvider>();

  register(provider: LLMProvider): this {
    const name = provider.name.trim().toLowerCase();
    if (!name) throw new HarnessValidationError("Provider name cannot be empty", "INVALID_PROVIDER");
    if (this.#providers.has(name)) {
      throw new HarnessValidationError(`Provider is already registered: ${name}`, "DUPLICATE_PROVIDER");
    }
    this.#providers.set(name, provider);
    return this;
  }

  get(name: string): LLMProvider {
    const provider = this.#providers.get(name.trim().toLowerCase());
    if (!provider) throw new HarnessValidationError(`Provider is not registered: ${name}`, "PROVIDER_NOT_FOUND");
    return provider;
  }

  list(): LLMProvider[] {
    return [...this.#providers.values()];
  }
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): this {
    const name = toolName.parse(definition.name);
    if (this.#tools.has(name)) {
      throw new HarnessValidationError(`Tool is already registered: ${name}`, "DUPLICATE_TOOL");
    }
    if (definition.providerSchema.type !== "object") {
      throw new HarnessValidationError(`Tool ${name} must expose an object JSON schema`, "INVALID_TOOL_SCHEMA");
    }
    if (definition.effectClass !== "PURE" && definition.effectClass !== "REPEATABLE_READ") {
      throw new HarnessValidationError(
        `Agent tool ${name} must be PURE or REPEATABLE_READ`,
        "UNSAFE_AGENT_TOOL",
      );
    }
    this.#tools.set(name, definition as ToolDefinition);
    return this;
  }

  get(name: string): ToolDefinition {
    const definition = this.#tools.get(name);
    if (!definition) throw new HarnessValidationError(`Unknown tool: ${name}`, "TOOL_NOT_FOUND");
    return definition;
  }

  providerTools(allowlist: readonly string[]): ProviderTool[] {
    return this.#resolveAllowlist(allowlist).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.providerSchema,
    }));
  }

  validateCall(call: NormalizedToolCall, allowlist: readonly string[]): NormalizedToolCall {
    if (!allowlist.includes(call.name)) {
      throw new HarnessValidationError(`Tool is not allowed for this agent: ${call.name}`, "TOOL_NOT_ALLOWED");
    }
    const tool = this.get(call.name);
    const parsed = tool.inputSchema.safeParse(call.arguments);
    if (!parsed.success) {
      throw new HarnessValidationError(
        `Invalid arguments for tool ${call.name}: ${parsed.error.message}`,
        "INVALID_TOOL_ARGUMENTS",
        { cause: parsed.error },
      );
    }
    return { ...call, arguments: parsed.data as JsonObject };
  }

  async execute(
    call: NormalizedToolCall,
    allowlist: readonly string[],
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const validated = this.validateCall(call, allowlist);
    const tool = this.get(validated.name);
    const input = tool.inputSchema.parse(validated.arguments);
    await tool.validateTarget?.(input, context);
    const output = await tool.execute(input, context);
    const parsedOutput = tool.outputSchema.safeParse(output);
    if (!parsedOutput.success) {
      throw new HarnessValidationError(
        `Tool ${validated.name} returned an invalid result: ${parsedOutput.error.message}`,
        "INVALID_TOOL_RESULT",
        { cause: parsedOutput.error },
      );
    }
    return {
      toolCallId: validated.id,
      name: validated.name,
      version: tool.version,
      output: parsedOutput.data,
    };
  }

  #resolveAllowlist(allowlist: readonly string[]): ToolDefinition[] {
    const unique = new Set<string>();
    return allowlist.map((name) => {
      if (unique.has(name)) {
        throw new HarnessValidationError(`Duplicate tool in allowlist: ${name}`, "DUPLICATE_TOOL_ALLOWLIST_ENTRY");
      }
      unique.add(name);
      return this.get(name);
    });
  }
}

export function createStringTargetValidator<T extends Record<string, unknown>>(
  field: keyof T & string,
  allowedValues: readonly string[],
): (input: T) => void {
  const allowed = new Set(allowedValues);
  return (input) => {
    const value = input[field];
    if (typeof value !== "string" || !allowed.has(value)) {
      throw new HarnessValidationError(`Target ${field} is not allowed`, "TARGET_NOT_ALLOWED");
    }
  };
}

export function createHttpTargetValidator<T extends Record<string, unknown>>(
  field: keyof T & string,
  allowedHosts: readonly string[],
): (input: T) => void {
  const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
  return (input) => {
    const value = input[field];
    if (typeof value !== "string") {
      throw new HarnessValidationError(`Target ${field} must be a URL`, "INVALID_TARGET");
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch (error) {
      throw new HarnessValidationError(`Target ${field} must be a valid URL`, "INVALID_TARGET", { cause: error });
    }
    if (
      url.protocol !== "https:" || url.username || url.password ||
      isIP(url.hostname) !== 0 || !allowed.has(url.hostname.toLowerCase())
    ) {
      throw new HarnessValidationError(`Target host is not allowed: ${url.hostname}`, "TARGET_NOT_ALLOWED");
    }
  };
}
