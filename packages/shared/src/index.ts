import { trace } from "@opentelemetry/api";
import { z } from "zod";

export const tracer = trace.getTracer("agentflow-runtime", "0.1.0");

export const stepKinds = ["DETERMINISTIC"] as const;
export const stepStatuses = [
  "PENDING",
  "READY",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
] as const;

export const workflowStepDefinitionSchema = z.object({
  key: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.enum(stepKinds).default("DETERMINISTIC"),
  handler: z.enum(["generate-summary", "finalize"]),
});

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
});

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
