import { trace, type Span } from "@opentelemetry/api";
import { z } from "zod";

export const tracer = trace.getTracer("agentflow-runtime", "0.1.0");

export const telemetrySchemaVersion = "1.0.0";
export const traceAttributes = {
  schemaVersion: "agentflow.telemetry.schema.version",
  runId: "agentflow.run.id",
  workflowVersionId: "agentflow.workflow.version.id",
  stepId: "agentflow.step.id",
  stepKey: "agentflow.step.key",
  stepKind: "agentflow.step.kind",
  attemptId: "agentflow.attempt.id",
  attemptNumber: "agentflow.attempt.number",
  leaseEpoch: "agentflow.attempt.lease_epoch",
} as const;

export function setExecutionSpanAttributes(
  span: Span,
  attributes: {
    runId?: string;
    workflowVersionId?: string;
    stepId?: string;
    stepKey?: string;
    stepKind?: string;
    attemptId?: string;
    attemptNumber?: number;
    leaseEpoch?: number;
  },
): void {
  span.setAttribute(traceAttributes.schemaVersion, telemetrySchemaVersion);
  if (attributes.runId) span.setAttribute(traceAttributes.runId, attributes.runId);
  if (attributes.workflowVersionId) {
    span.setAttribute(traceAttributes.workflowVersionId, attributes.workflowVersionId);
  }
  if (attributes.stepId) span.setAttribute(traceAttributes.stepId, attributes.stepId);
  if (attributes.stepKey) span.setAttribute(traceAttributes.stepKey, attributes.stepKey);
  if (attributes.stepKind) span.setAttribute(traceAttributes.stepKind, attributes.stepKind);
  if (attributes.attemptId) span.setAttribute(traceAttributes.attemptId, attributes.attemptId);
  if (attributes.attemptNumber !== undefined) {
    span.setAttribute(traceAttributes.attemptNumber, attributes.attemptNumber);
  }
  if (attributes.leaseEpoch !== undefined) {
    span.setAttribute(traceAttributes.leaseEpoch, attributes.leaseEpoch);
  }
}

export const stepKinds = ["DETERMINISTIC", "APPROVAL", "TOOL", "AGENT"] as const;
export const effectClasses = [
  "PURE",
  "REPEATABLE_READ",
  "RECEIVER_IDEMPOTENT_WRITE",
  "TRANSACTIONAL_LOCAL_WRITE",
  "RECONCILIABLE_WRITE",
  "UNSAFE_WRITE",
] as const;
export const stepStatuses = [
  "PENDING",
  "READY",
  "RUNNING",
  "RETRY_WAIT",
  "WAITING_APPROVAL",
  "UNKNOWN",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;

export const runLifecycles = ["OPEN", "SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "BUDGET_EXCEEDED"] as const;
export const runControls = ["RUN", "PAUSE_REQUESTED", "PAUSED", "CANCEL_REQUESTED"] as const;
export const runWaitReasons = ["NONE", "RETRY", "APPROVAL", "RECONCILIATION"] as const;

export const defaultRetryPolicy = {
  maxAttempts: 3,
  initialBackoffMs: 1_000,
  multiplier: 2,
  maxBackoffMs: 30_000,
} as const;

export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(20).default(defaultRetryPolicy.maxAttempts),
  initialBackoffMs: z.number().int().min(0).max(300_000).default(defaultRetryPolicy.initialBackoffMs),
  multiplier: z.number().min(1).max(10).default(defaultRetryPolicy.multiplier),
  maxBackoffMs: z.number().int().min(0).max(3_600_000).default(defaultRetryPolicy.maxBackoffMs),
}).refine(
  (policy) => policy.maxBackoffMs >= policy.initialBackoffMs,
  { message: "maxBackoffMs must be greater than or equal to initialBackoffMs" },
);

export type RetryPolicy = z.infer<typeof retryPolicySchema>;

const deterministicStepDefinitionSchema = z.object({
  key: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.literal("DETERMINISTIC").default("DETERMINISTIC"),
  handler: z.enum([
    "generate-summary",
    "finalize",
    "select-aws-sources",
    "select-azure-sources",
    "select-gcp-sources",
    "collect-sources",
    "generate-cloud-report",
  ]),
});

const approvalStepDefinitionSchema = z.object({
  key: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.literal("APPROVAL"),
  handler: z.literal("approval"),
  reviewerRole: z.string().trim().min(1).max(100),
  expiresAfterMs: z.number().int().min(1_000).max(30 * 24 * 60 * 60 * 1_000),
});

const toolStepDefinitionSchema = z.object({
  key: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.literal("TOOL"),
  handler: z.enum(["publish-report", "publish-approved-report"]),
  toolVersion: z.string().trim().min(1).max(100).default("1"),
  effectClass: z.enum([
    "RECEIVER_IDEMPOTENT_WRITE",
    "UNSAFE_WRITE",
  ]),
});

const agentInputPathSchema = z.string().max(200).regex(
  /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/,
  "Agent input must be a dot-path such as sourceSet or request.assumptions",
);

const agentStepDefinitionSchema = z.object({
  key: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.literal("AGENT"),
  handler: z.literal("agent"),
  provider: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(20_000),
  allowedTools: z.array(z.string().min(1).max(128)).max(20).default([]),
  maxTurns: z.number().int().min(1).max(20).default(10),
  maxOutputTokens: z.number().int().min(1).max(100_000).optional(),
  /** Sampling temperature (0 = most deterministic) and best-effort seed for live providers. */
  temperature: z.number().min(0).max(2).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  outputKey: z.string().min(1).max(100).regex(/^[a-z][a-zA-Z0-9]*$/).optional(),
  /**
   * Per-step context minimization (brief §2.4): dot-paths into the step's input state
   * that the prompt may include. Absent means the full input (backward compatible).
   * The step's output still carries the full state; only the prompt is narrowed.
   */
  inputs: z.array(agentInputPathSchema).min(1).max(20).optional(),
}).superRefine((definition, context) => {
  const unique = new Set(definition.allowedTools);
  if (unique.size !== definition.allowedTools.length) {
    context.addIssue({ code: "custom", path: ["allowedTools"], message: "Agent tool allowlist contains duplicates" });
  }
  if (definition.inputs && new Set(definition.inputs).size !== definition.inputs.length) {
    context.addIssue({ code: "custom", path: ["inputs"], message: "Agent inputs contain duplicates" });
  }
});

export const workflowStepDefinitionSchema = z.union([
  deterministicStepDefinitionSchema,
  approvalStepDefinitionSchema,
  toolStepDefinitionSchema,
  agentStepDefinitionSchema,
]);

/**
 * LLM response cache scope for a workflow version (brief §2.2). Absent means "run".
 * There is deliberately no default, so definitions without it keep their hash.
 * - run: reuse an accepted response for an identical request within the same run.
 * - version: also reuse across runs of the same immutable workflow version (opt-in).
 * - off: always call the provider (crash-recovery journal replay still applies).
 */
export const cacheScopeSchema = z.enum(["run", "version", "off"]);
export type CacheScope = z.infer<typeof cacheScopeSchema>;

export const workflowDefinitionSchema = z.object({
  steps: z.array(workflowStepDefinitionSchema).min(1).max(20),
  cacheScope: cacheScopeSchema.optional(),
}).superRefine((definition, context) => {
  const keys = new Set<string>();
  definition.steps.forEach((step, index) => {
    if (keys.has(step.key)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate step key: ${step.key}`,
        path: ["steps", index, "key"],
      });
    }
    keys.add(step.key);
  });
  // Declared agent inputs must be produced upstream. Every handler's output keys are
  // known statically (stepOutputKeys); only the run input itself is an open set, so
  // roots are checked here whenever the state shape is known, and at runtime always.
  let state: StateKeys = { open: true, keys: new Set() };
  definition.steps.forEach((step, index) => {
    if (step.kind === "AGENT" && step.inputs && !state.open) {
      step.inputs.forEach((path, inputIndex) => {
        const root = path.split(".")[0]!;
        if (!state.keys.has(root)) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "inputs", inputIndex],
            message: `Agent input ${path}: no upstream step produces ${root}`,
          });
        }
      });
    }
    state = stepOutputKeys(step, state);
  });
});

/** Statically known top-level keys of the state object flowing between steps. */
export interface StateKeys {
  /** True while the shape still includes the arbitrary run input. */
  open: boolean;
  keys: ReadonlySet<string>;
}

const agentResultKeys = ["content", "finishReason", "provider", "model", "turns"];

/** Output-key contract of each step kind/handler (mirrors the handlers in runtime and research). */
export function stepOutputKeys(step: WorkflowStepDefinition, previous: StateKeys): StateKeys {
  const closed = (keys: Iterable<string>): StateKeys => ({ open: false, keys: new Set(keys) });
  switch (step.kind) {
    case "APPROVAL":
      return previous;
    case "TOOL":
      return closed(["published", "receiverId", "receipt", "receiverReplayed"]);
    case "AGENT":
      return step.outputKey
        ? { open: previous.open, keys: new Set([...previous.keys, step.outputKey]) }
        : closed(agentResultKeys);
    default:
      switch (step.handler) {
        case "generate-summary":
          return closed(["summary", "source"]);
        case "finalize":
          return closed(["finalized", "result"]);
        case "generate-cloud-report":
          return closed(["report", "publication", "sourceSet", "approvalBinding"]);
        default:
          // select-*-sources and collect-sources wrap the run input as `request`
          // (or carry an existing reference state forward) and add `sourceSet`.
          return closed([...previous.keys, "request", "sourceSet"]);
      }
  }
}

export class AgentInputProjectionError extends Error {
  constructor(readonly path: string) {
    super(`Declared agent input ${path} is missing from the step input`);
    this.name = "AgentInputProjectionError";
  }
}

/**
 * Builds the prompt input for an AGENT step that declares `inputs`: only the declared
 * dot-paths, with their nesting preserved. A missing root is a definition or handler
 * bug and throws; a missing nested segment (an optional field) is omitted.
 */
export function projectAgentInput(input: Record<string, unknown>, paths: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const path of paths) {
    const segments = path.split(".");
    if (!Object.prototype.hasOwnProperty.call(input, segments[0]!)) throw new AgentInputProjectionError(path);
    let source: unknown = input;
    let found = true;
    for (const segment of segments) {
      if (source === null || typeof source !== "object" || Array.isArray(source) ||
          !Object.prototype.hasOwnProperty.call(source, segment)) {
        found = false;
        break;
      }
      source = (source as Record<string, unknown>)[segment];
    }
    if (!found) continue;
    let target = projected;
    segments.slice(0, -1).forEach((segment) => {
      const next = target[segment];
      target = (next !== null && typeof next === "object" && !Array.isArray(next)
        ? next
        : (target[segment] = {})) as Record<string, unknown>;
    });
    target[segments.at(-1)!] = structuredClone(source);
  }
  return projected;
}

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowStepDefinition = z.infer<typeof workflowStepDefinitionSchema>;

export const defaultWorkflowDefinition: WorkflowDefinition = {
  steps: [
    { key: "generate-summary", kind: "DETERMINISTIC", handler: "generate-summary" },
    { key: "finalize", kind: "DETERMINISTIC", handler: "finalize" },
  ],
};

export const queueName = "agentflow-operations";

export const operationJobSchema = z.object({
  runId: z.string().uuid(),
  operationId: z.string().uuid(),
  workflowVersionId: z.string().uuid(),
  dispatchGeneration: z.number().int().positive(),
});

export type OperationJob = z.infer<typeof operationJobSchema>;

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1_000).default(""),
});

export const createWorkflowVersionSchema = z.object({
  version: z.number().int().positive(),
  definition: workflowDefinitionSchema.default(defaultWorkflowDefinition),
});

export const createRunSchema = z.object({
  workflowVersionId: z.string().uuid(),
  input: z.record(z.string(), z.unknown()),
  creationKey: z.string().min(1).max(200).optional(),
  deadlineMs: z.number().int().min(1_000).max(86_400_000).default(300_000),
  retryPolicy: retryPolicySchema.default(defaultRetryPolicy),
  /** Run-level budget on billed LLM tokens (input + output, brief §2.5). */
  maxTokens: z.number().int().min(1).max(1_000_000_000).optional(),
  /** Run-level budget in USD; requires a configured price for every AGENT model. */
  maxCostUsd: z.number().positive().max(1_000_000).optional(),
});

/** Operator-configured price for one provider/model, in USD per million tokens. */
export const modelPriceSchema = z.object({
  inputPer1M: z.number().min(0),
  cachedInputPer1M: z.number().min(0).optional(),
  outputPer1M: z.number().min(0),
}).strict();
export type ModelPrice = z.infer<typeof modelPriceSchema>;

/** Keyed by "<provider>/<model>", e.g. "gemini/gemini-3.5-flash". */
export const modelPriceTableSchema = z.record(z.string().regex(/^[^/\s]+\/.+$/, "Price keys are provider/model"), modelPriceSchema);
export type ModelPriceTable = z.infer<typeof modelPriceTableSchema>;

export interface PriceableUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
}

/**
 * USD cost of one billed usage record under the normalized usage convention: cached
 * tokens are a subset of input (billed at the cached rate when one is configured) and
 * reasoning tokens are already inside output. Returns null when the provider reported
 * no counts; such calls are never estimated.
 */
export function usageCostUsd(usage: PriceableUsage, price: ModelPrice): number | null {
  if (usage.inputTokens === null && usage.outputTokens === null) return null;
  const input = usage.inputTokens ?? 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, input);
  const output = usage.outputTokens ?? 0;
  return ((input - cached) * price.inputPer1M
    + cached * (price.cachedInputPer1M ?? price.inputPer1M)
    + output * price.outputPer1M) / 1_000_000;
}

export const approvalDecisionSchema = z.object({
  decisionRequestId: z.string().uuid(),
  decision: z.enum(["APPROVE", "REJECT"]),
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const reconciliationDecisionSchema = z.object({
  resolution: z.enum(["CONFIRM_SUCCEEDED", "FAIL_FINAL"]),
  receiverId: z.string().trim().min(1).max(200).optional(),
  receipt: z.record(z.string(), z.unknown()).optional(),
}).superRefine((decision, context) => {
  if (decision.resolution === "CONFIRM_SUCCEEDED" && (!decision.receiverId || !decision.receipt)) {
    context.addIssue({
      code: "custom",
      message: "CONFIRM_SUCCEEDED requires receiverId and receipt",
    });
  }
});

export type ReconciliationDecision = z.infer<typeof reconciliationDecisionSchema>;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
