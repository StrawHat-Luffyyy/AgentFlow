export type Tone = "success" | "warning" | "danger" | "info" | "waiting" | "neutral";

/** One mapping from persisted state values to visual tone, shared by every status display. */
const toneByStatus: Record<string, Tone> = {
  SUCCEEDED: "success",
  APPROVED: "success",
  FAILED: "danger",
  TIMED_OUT: "danger",
  BUDGET_EXCEEDED: "danger",
  REJECTED: "danger",
  EXPIRED: "danger",
  RUNNING: "info",
  WAITING_APPROVAL: "waiting",
  QUEUED: "waiting",
  READY: "waiting",
  PENDING: "waiting",
  RETRY_WAIT: "warning",
  NEEDS_ATTENTION: "warning",
  UNKNOWN: "warning",
  PAUSED: "warning",
  PAUSE_REQUESTED: "warning",
  CANCEL_REQUESTED: "warning",
  CANCELLED: "neutral",
  ABANDONED: "warning",
};

export function statusTone(status: string): Tone {
  return toneByStatus[status] ?? "neutral";
}

/** Statuses after which nothing more will happen to a run. */
export const terminalStatuses = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "BUDGET_EXCEEDED"]);
