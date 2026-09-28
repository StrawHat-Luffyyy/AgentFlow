import { trace } from "@opentelemetry/api";
import { z } from "zod";

export const tracer = trace.getTracer("agentflow-runtime", "0.1.0");

export const stepKinds = ["DETERMINISTIC", "APPROVAL"] as const;
export const stepStatuses = [
  "PENDING",
  "READY",
  "RUNNING",
  "RETRY_WAIT",
  "WAITING_APPROVAL",
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
  handler: z.enum(["generate-summary", "finalize"]),
});

const approvalStepDefinitionSchema = z.object({
  key: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.literal("APPROVAL"),
  handler: z.literal("approval"),
  reviewerRole: z.string().trim().min(1).max(100),
  expiresAfterMs: z.number().int().min(1_000).max(30 * 24 * 60 * 60 * 1_000),
});

export const workflowStepDefinitionSchema = z.union([
  deterministicStepDefinitionSchema,
  approvalStepDefinitionSchema,
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
