let bearerToken = "";
export function setBearerToken(value: string): void { bearerToken = value; }

const apiBase = import.meta.env.VITE_API_BASE_URL || "/api";

export interface RunSummary {
  id: string;
  workflowVersionId: string;
  workflowName: string;
  workflowVersion: number;
  lifecycle: string;
  control: string;
  waitReason: string;
  publicStatus: string;
  createdAt: string;
  finishedAt: string | null;
  deadlineAt: string;
  failure: JsonValue | null;
  stepCount: number;
  completedStepCount: number;
  attemptCount: number;
  inputTokens: number;
  outputTokens: number;
  /** Distinct LLM providers of the run's AGENT steps. */
  providers?: string[];
  workflowId?: string;
  maxTokens?: number | null;
  maxCostUsd?: number | null;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface Step {
  id: string;
  nodeKey: string;
  position: number;
  kind: string;
  handler: string;
  status: string;
  effectClass?: string;
  input: JsonValue;
  acceptedOutput: JsonValue | null;
  failure: JsonValue | null;
  attemptCount: number;
  maxAttempts: number;
  /** Current fencing epoch and lease holder (null when no worker holds the step). */
  leaseEpoch?: number;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  dispatchGeneration?: number;
  createdAt: string;
  completedAt: string | null;
  nextAttemptAt: string | null;
}

export interface RunDetail {
  id: string;
  workflowVersionId: string;
  lifecycle: string;
  control: string;
  waitReason: string;
  publicStatus: string;
  input: JsonValue;
  stateRevision: number;
  createdAt: string;
  finishedAt: string | null;
  deadlineAt: string;
  failure: JsonValue | null;
  steps: Step[];
  checkpoint: { id: string; revision: number; reason: string; createdAt: string };
  providers?: string[];
  /** Run budget (brief 2.5); null or absent when unbudgeted. */
  maxTokens?: number | null;
  maxCostUsd?: number | null;
  workflowId?: string;
  workflowName?: string;
  workflowVersion?: number;
}

export interface Attempt {
  id: string;
  stepId: string;
  stepKey: string;
  stepPosition: number;
  attemptNo: number;
  epoch: number;
  workerId: string;
  status: string;
  startedAt: string;
  deadlineAt: string;
  finishedAt: string | null;
  errorClass: string | null;
  retryable: boolean | null;
  error: JsonValue | null;
}

export interface Approval {
  id: string;
  stepId: string;
  generation: number;
  status: string;
  proposal: JsonValue;
  proposalHash: string;
  payload: JsonValue;
  payloadHash: string;
  reviewerRole: string;
  expiresAt: string;
  decision: string | null;
  createdAt: string;
}

export interface HistoryEvent {
  id: string;
  sequence: number;
  stepId: string | null;
  attemptId: string | null;
  type: string;
  payload: JsonValue;
  createdAt: string;
}

/** The subset of the API's usage summary the dashboard shows: tokens avoided by journal replay and the response cache. */
export interface ServerUsageSummary {
  replayedCalls: number;
  savedByReplayInputTokens: number;
  savedByReplayOutputTokens: number;
  cacheHitCalls: number;
  savedByCacheInputTokens: number;
  savedByCacheOutputTokens: number;
  cacheScope: "run" | "version" | "off" | null;
  cacheLookups: { hits: number; misses: number; off: number };
  billedCalls?: number;
  unreportedCalls?: number;
  billedInputTokens?: number;
  billedOutputTokens?: number;
  billedCachedInputTokens?: number;
  billedReasoningTokens?: number;
  provenance?: Record<string, number>;
  byStep?: StepUsageSummary[];
  budget?: { tokensUsed: number; maxTokens: number | null; costUsd: number | null; maxCostUsd: number | null; unreportedCalls: number } | null;
}

/** Per-step slice of the usage summary (billed, cached, reasoning, journal-replayed and cache-hit tokens). */
export interface StepUsageSummary {
  stepId: string;
  billedCalls: number;
  unreportedCalls: number;
  billedInputTokens: number;
  billedOutputTokens: number;
  billedCachedInputTokens: number;
  billedReasoningTokens: number;
  replayedCalls: number;
  savedByReplayInputTokens: number;
  savedByReplayOutputTokens: number;
  cacheHitCalls: number;
  savedByCacheInputTokens: number;
  savedByCacheOutputTokens: number;
  cacheLookups?: { hits: number; misses: number; off: number };
}

export interface ToolExecution {
  id: string;
  stepId: string;
  attemptId: string;
  toolName: string;
  toolVersion: string;
  effectClass: string;
  requestHash: string;
  idempotencyKey: string;
  idempotencyStatus: string;
  invocationStatus: string;
  receiverId: string | null;
  receipt: JsonValue | null;
  sentAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface RunFilters {
  status?: string[];
  workflowId?: string;
  from?: string;
  to?: string;
}

export interface Readiness {
  status: string;
  database?: string;
  queue?: string;
}

export interface UsageRecord {
  id: string;
  stepId: string;
  attemptId: string;
  provider: string;
  model: string;
  provenance: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  createdAt: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  latestVersion: number | null;
  versionCount: number;
}

export interface WorkflowVersionSummary {
  id: string;
  version: number;
  createdAt: string;
  stepCount: number;
  providers: string[];
}

export interface WorkflowDetail extends Omit<WorkflowSummary, "latestVersion" | "versionCount"> {
  versions: WorkflowVersionSummary[];
}

export interface ProviderAvailability {
  workers: number;
  providers: Array<{ name: string; models: string[]; workerCount: number; lastSeenAt: string }>;
}

export interface ReferenceSetup {
  workflowId: string;
  workflowVersionId: string;
  workflowName: string;
  version: number;
  created: boolean;
  mode: string;
  provider: string;
  model: string;
}

export interface CreateRunBody {
  workflowVersionId: string;
  input: Record<string, unknown>;
  creationKey?: string;
  deadlineMs?: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

/** HTTP status 0 means the API could not be reached at all. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      credentials: "include",
      headers,
    });
  } catch {
    throw new ApiError("AgentFlow API is unreachable", 0);
  }
  const body = await response.json().catch(() => ({})) as {
    message?: string;
    error?: string;
    details?: Array<{ path?: Array<string | number>; message?: string }>;
  };
  if (!response.ok) {
    const issues = Array.isArray(body.details)
      ? body.details.map((issue) => `${issue.path?.length ? issue.path.join(".") : "input"}: ${issue.message ?? "invalid"}`).join("; ")
      : "";
    const reason = issues || body.message || body.error;
    throw new ApiError(reason ? `${reason} (${response.status})` : `Request failed (${response.status})`, response.status);
  }
  return body as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ user: { id: string; username: string; roles: string[] } }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ status: string }>("/auth/logout", { method: "POST" }),
  me: () => request<{ id: string; roles: string[]; username?: string }>("/me"),
  listRuns: (filters: RunFilters = {}) => {
    const query = new URLSearchParams({ limit: "100" });
    if (filters.status?.length) query.set("status", filters.status.join(","));
    if (filters.workflowId) query.set("workflowId", filters.workflowId);
    if (filters.from) query.set("from", filters.from);
    if (filters.to) query.set("to", filters.to);
    return request<{ runs: RunSummary[]; total: number }>(`/runs?${query.toString()}`);
  },
  ready: () => request<Readiness>("/ready"),
  listApprovals: () => request<{ approvals: Array<Approval & { runId?: string }> }>("/approvals"),
  getToolExecutions: (id: string) => request<{ executions: ToolExecution[] }>(`/runs/${id}/tool-executions`),
  getRun: (id: string) => request<RunDetail>(`/runs/${id}`),
  getAttempts: (id: string) => request<{ attempts: Attempt[] }>(`/runs/${id}/attempts`),
  getApprovals: (id: string) => request<{ approvals: Approval[] }>(`/runs/${id}/approvals`),
  getHistory: (id: string) => request<{ events: HistoryEvent[] }>(`/runs/${id}/history`),
  getUsage: (id: string) => request<{ usage: UsageRecord[]; summary?: ServerUsageSummary }>(`/runs/${id}/usage`),
  listWorkflows: () => request<{ workflows: WorkflowSummary[] }>("/workflows"),
  getWorkflow: (id: string) => request<WorkflowDetail>(`/workflows/${encodeURIComponent(id)}`),
  runtimeProviders: () => request<ProviderAvailability>("/runtime/providers"),
  setupReference: (body: { mode: "scripted" } | { mode: "live"; provider: string; model: string }) =>
    request<ReferenceSetup>("/reference-workflows/cloud-comparison", { method: "POST", body: JSON.stringify(body) }),
  createRun: (body: CreateRunBody) =>
    request<RunDetail>("/runs", { method: "POST", body: JSON.stringify(body) }),
  controlRun: (id: string, command: "pause" | "resume" | "cancel") =>
    request<RunDetail>(`/runs/${id}/${command}`, { method: "POST" }),
  decideApproval: (
    approval: Approval,
    decision: "APPROVE" | "REJECT",
  ) => request(`/approvals/${approval.id}/decisions`, {
    method: "POST",
    body: JSON.stringify({
      decisionRequestId: crypto.randomUUID(),
      decision,
      proposalHash: approval.proposalHash,
      payloadHash: approval.payloadHash,
    }),
  }),
};
