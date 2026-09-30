import {
  ProviderError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type ProviderCapabilities,
  type ProviderExecutionContext,
} from "@agentflow/harness";

const capabilities: ProviderCapabilities = {
  toolCalls: false,
  structuredOutput: false,
  streaming: false,
  contentTypes: ["text"],
  cancellation: true,
  serverSideState: false,
};

function tokenEstimate(value: string): number {
  const words = value.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words * 1.35));
}

export class ScriptedResearchProvider implements LLMProvider {
  readonly name = "scripted-research";
  readonly adapterVersion = "1.0.0";
  readonly capabilities = capabilities;

  async execute(request: LLMRequest, context: ProviderExecutionContext): Promise<LLMResponse> {
    if (context.signal?.aborted || context.deadlineAt.getTime() <= Date.now()) {
      throw new ProviderError(
        "Scripted research operation deadline expired",
        "TIMEOUT",
        "SCRIPTED_PROVIDER_TIMEOUT",
      );
    }
    const instructions = request.instructions ?? "";
    const task = instructions.includes("[cloud-comparison:pricing]")
      ? "pricing"
      : instructions.includes("[cloud-comparison:features]")
        ? "features"
        : null;
    if (!task) {
      throw new ProviderError(
        "Scripted research provider received an unsupported prompt",
        "PERMANENT",
        "UNSUPPORTED_SCRIPTED_PROMPT",
      );
    }
    const text = task === "pricing"
      ? "Under the fixed workload assumptions, all three vendors require region-, compute-, storage-, and network-aware estimates. AWS evidence emphasizes commitment-free EC2 On-Demand capacity [aws-ec2-pricing]; Azure evidence requires holding VM size, region, OS, and purchase option constant [azure-vm-pricing]; GCP evidence separates resource pricing and discount eligibility [gcp-compute-pricing]. The corpus intentionally contains no normalized live SKU quote, so the report must not rank vendors by price."
      : "The managed-Kubernetes evidence shows a shared managed-control-plane model with different operating modes. EKS offers standard and more automated choices while retaining separate worker-resource considerations [aws-eks-overview]. AKS contrasts Automatic defaults with Standard control [azure-aks-overview]. GKE contrasts Autopilot with Standard around node management, scaling, and billing basis [gcp-gke-overview]. Selection should follow workload and operating-model requirements rather than a universal feature winner.";
    const inputText = request.messages.map((message) => message.content).join("\n");
    return {
      text,
      toolCalls: [],
      finishReason: "stop",
      usage: {
        provenance: "estimated",
        inputTokens: tokenEstimate(`${instructions}\n${inputText}`),
        outputTokens: tokenEstimate(text),
        cachedInputTokens: 0,
        reasoningTokens: null,
        raw: { scripted: true, estimator: "word-count-1.35", task },
      },
      providerRequestId: `scripted:${context.logicalOperationId}`,
      resolvedModel: request.model,
      opaqueState: { namespace: "agentflow.scripted-research", version: 1, task },
    };
  }
}
