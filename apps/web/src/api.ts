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
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface Step {
  id: string;
  nodeKey: string;
  position: number;
  kind: string;
  handler: string;
  status: string;
  input: JsonValue;
  acceptedOutput: JsonValue | null;
  failure: JsonValue | null;
  attemptCount: number;
  maxAttempts: number;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || `Request failed (${response.status})`);
  return body as T;
}

export const api = {
  listRuns: () => request<{ runs: RunSummary[]; total: number }>("/runs?limit=100"),
  getRun: (id: string) => request<RunDetail>(`/runs/${id}`),
  getAttempts: (id: string) => request<{ attempts: Attempt[] }>(`/runs/${id}/attempts`),
  getApprovals: (id: string) => request<{ approvals: Approval[] }>(`/runs/${id}/approvals`),
  getHistory: (id: string) => request<{ events: HistoryEvent[] }>(`/runs/${id}/history`),
  getUsage: (id: string) => request<{ usage: UsageRecord[] }>(`/runs/${id}/usage`),
  controlRun: (id: string, command: "pause" | "resume" | "cancel") =>
    request<RunDetail>(`/runs/${id}/${command}`, { method: "POST" }),
  decideApproval: (
    approval: Approval,
    decision: "APPROVE" | "REJECT",
    reviewerId: string,
    reviewerRole: string,
  ) => request(`/approvals/${approval.id}/decisions`, {
    method: "POST",
    headers: {
      "x-agentflow-reviewer-id": reviewerId,
      "x-agentflow-reviewer-role": reviewerRole,
    },
    body: JSON.stringify({
      decisionRequestId: crypto.randomUUID(),
      decision,
      proposalHash: approval.proposalHash,
      payloadHash: approval.payloadHash,
    }),
  }),
};
