import { z } from "zod";

// Response schemas validate only the fields the CLI renders; `.passthrough()` keeps
// every other field so `--json` prints the API body unchanged.

const timestamp = z.string();
const nullableTimestamp = z.string().nullable();

export const meSchema = z.object({
  id: z.string(),
  roles: z.array(z.string()),
  username: z.string().optional(),
}).passthrough();

export const loginSchema = z.object({
  user: z.object({ id: z.string(), username: z.string(), roles: z.array(z.string()) }).passthrough(),
}).passthrough();

export const healthSchema = z.object({ status: z.string() }).passthrough();
export const readySchema = z.object({ status: z.string(), database: z.string(), queue: z.string() }).passthrough();
export const okSchema = z.object({}).passthrough();

export const runSummarySchema = z.object({
  id: z.string(),
  workflowVersionId: z.string(),
  workflowName: z.string(),
  workflowVersion: z.number(),
  publicStatus: z.string(),
  createdAt: timestamp,
  stepCount: z.number(),
  completedStepCount: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
}).passthrough();

export const runListSchema = z.object({
  runs: z.array(runSummarySchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
}).passthrough();

export const stepSchema = z.object({
  id: z.string(),
  nodeKey: z.string(),
  position: z.number(),
  kind: z.string(),
  status: z.string(),
  attemptCount: z.number(),
  maxAttempts: z.number(),
  createdAt: timestamp,
  completedAt: nullableTimestamp.optional(),
  failure: z.unknown().optional(),
}).passthrough();

export const runDetailSchema = z.object({
  id: z.string(),
  workflowVersionId: z.string(),
  lifecycle: z.string(),
  publicStatus: z.string(),
  createdAt: timestamp,
  finishedAt: nullableTimestamp,
  deadlineAt: timestamp,
  failure: z.unknown().optional(),
  steps: z.array(stepSchema),
}).passthrough();

export const historyEventSchema = z.object({
  id: z.string(),
  sequence: z.number(),
  stepId: z.string().nullable(),
  attemptId: z.string().nullable(),
  type: z.string(),
  payload: z.unknown(),
  createdAt: timestamp,
}).passthrough();
export const historySchema = z.object({ events: z.array(historyEventSchema) }).passthrough();

export const attemptsSchema = z.object({
  attempts: z.array(z.object({
    id: z.string(),
    stepKey: z.string(),
    attemptNo: z.number(),
    epoch: z.number(),
    workerId: z.string(),
    status: z.string(),
    startedAt: timestamp,
    finishedAt: nullableTimestamp,
    errorClass: z.string().nullable(),
  }).passthrough()),
}).passthrough();

export const approvalSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string(),
  status: z.string(),
  proposal: z.unknown(),
  proposalHash: z.string(),
  payload: z.unknown(),
  payloadHash: z.string(),
  reviewerRole: z.string(),
  expiresAt: timestamp,
  createdAt: timestamp,
}).passthrough();
export const approvalsSchema = z.object({ approvals: z.array(approvalSchema) }).passthrough();

export const toolExecutionsSchema = z.object({
  executions: z.array(z.object({
    id: z.string(),
    toolName: z.string(),
    effectClass: z.string(),
    invocationStatus: z.string(),
    receiverId: z.string().nullable(),
    createdAt: timestamp,
  }).passthrough()),
}).passthrough();

export const harnessOpsSchema = z.object({
  operations: z.array(z.object({
    id: z.string(),
    stepId: z.string(),
    ordinal: z.number(),
    kind: z.string(),
    turn: z.number().nullable(),
    status: z.string(),
    createdAt: timestamp,
  }).passthrough()),
}).passthrough();

export const usageSchema = z.object({
  usage: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    createdAt: timestamp,
  }).passthrough()),
}).passthrough();

export const sourcesSchema = z.object({
  sources: z.array(z.object({
    id: z.string(),
    ordinal: z.number(),
    vendor: z.string(),
    title: z.string(),
    sourceUrl: z.string(),
  }).passthrough()),
}).passthrough();

export const workflowSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  createdAt: timestamp,
  latestVersion: z.number().nullable(),
  versionCount: z.number(),
}).passthrough();
export const workflowListSchema = z.object({ workflows: z.array(workflowSummarySchema) }).passthrough();

export const workflowDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  createdAt: timestamp,
  versions: z.array(z.object({
    id: z.string(),
    version: z.number(),
    createdAt: timestamp,
    stepCount: z.number(),
  }).passthrough()),
}).passthrough();

export const workflowCreatedSchema = z.object({ id: z.string(), name: z.string() }).passthrough();
export const versionCreatedSchema = z.object({ id: z.string(), workflowId: z.string(), version: z.number() }).passthrough();

export const referenceSetupSchema = z.object({
  workflowId: z.string(),
  workflowVersionId: z.string(),
  workflowName: z.string(),
  version: z.number(),
  created: z.boolean(),
  mode: z.string(),
  provider: z.string(),
}).passthrough();

export type Me = z.infer<typeof meSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type RunList = z.infer<typeof runListSchema>;
export type RunDetail = z.infer<typeof runDetailSchema>;
export type HistoryEvent = z.infer<typeof historyEventSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;
export type WorkflowDetail = z.infer<typeof workflowDetailSchema>;
