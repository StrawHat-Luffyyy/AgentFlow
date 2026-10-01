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

export const runLifecycles = ["OPEN", "SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"] as const;
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
  outputKey: z.string().min(1).max(100).regex(/^[a-z][a-zA-Z0-9]*$/).optional(),
}).superRefine((definition, context) => {
  const unique = new Set(definition.allowedTools);
  if (unique.size !== definition.allowedTools.length) {
    context.addIssue({ code: "custom", path: ["allowedTools"], message: "Agent tool allowlist contains duplicates" });
  }
});

export const workflowStepDefinitionSchema = z.union([
  deterministicStepDefinitionSchema,
  approvalStepDefinitionSchema,
  toolStepDefinitionSchema,
  agentStepDefinitionSchema,
]);

export const workflowDefinitionSchema = z.object({
  steps: z.array(workflowStepDefinitionSchema).min(1).max(20),
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
});

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
});

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
