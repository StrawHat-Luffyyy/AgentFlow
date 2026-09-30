import { ProviderError } from "../errors.js";
import type {
  JsonObject,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
  ProviderExecutionContext,
} from "../types.js";

export type FakeProviderStep =
  | LLMResponse
  | ProviderError
  | ((request: LLMRequest, context: ProviderExecutionContext, callIndex: number) => LLMResponse | Promise<LLMResponse>);

const capabilities: ProviderCapabilities = {
  toolCalls: true,
  structuredOutput: true,
  streaming: false,
  contentTypes: ["text"],
  cancellation: true,
  serverSideState: true,
};

export class DeterministicFakeProvider implements LLMProvider {
  readonly name = "fake";
  readonly adapterVersion = "1.0.0";
  readonly capabilities = capabilities;
  readonly calls: Array<{ request: LLMRequest; context: ProviderExecutionContext }> = [];
  #next = 0;

  constructor(private readonly script: readonly FakeProviderStep[] = []) {}

  async execute(request: LLMRequest, context: ProviderExecutionContext): Promise<LLMResponse> {
    const callIndex = this.#next++;
    this.calls.push({ request: structuredClone(request), context: { ...context } });
    const step = this.script[callIndex];
    if (step instanceof ProviderError) throw step;
    if (typeof step === "function") return structuredClone(await step(request, context, callIndex));
    if (step) return structuredClone(step);

    const state: JsonObject = { namespace: "agentflow.fake", version: 1, nextCall: callIndex + 1 };
    return {
      text: `fake-response-${callIndex + 1}`,
      toolCalls: [],
      finishReason: "stop",
      usage: {
        provenance: "reported",
        inputTokens: request.messages.length,
        outputTokens: 1,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        raw: { deterministic: true },
      },
      providerRequestId: `fake-request-${callIndex + 1}`,
      resolvedModel: request.model,
      opaqueState: state,
    };
  }
}
