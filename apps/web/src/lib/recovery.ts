// Recovery events are the product's story: what broke, and how the runtime recovered
// without repeating committed work. Derived purely from the persisted audit history.
import type { Tone } from "../design/status.js";

export interface HistoryLike {
  id: string;
  sequence: number;
  stepId: string | null;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface RecoveryEvent {
  id: string;
  sequence: number;
  type: string;
  stepId: string | null;
  createdAt: string;
  label: string;
  description: string;
  tone: Tone;
}

type Describe = (payload: Record<string, unknown>) => string;

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

const recoveryTypes: Record<string, { label: string; tone: Tone; describe: Describe }> = {
  LEASE_EXPIRED: {
    label: "Lease expired",
    tone: "warning",
    describe: (p) => `Worker stopped renewing its lease${num(p.expiredEpoch) !== null ? ` (epoch ${p.expiredEpoch})` : ""}; ${p.retryScheduled ? "a new attempt was scheduled" : "no attempts remained"}.`,
  },
  ATTEMPT_TIMEOUT: {
    label: "Attempt timed out",
    tone: "warning",
    describe: (p) => `The attempt exceeded its deadline; ${p.retryScheduled ? "a new attempt was scheduled" : "no attempts remained"}.`,
  },
  DISPATCH_RECOVERED: {
    label: "Re-dispatched",
    tone: "info",
    describe: () => "A lost queue delivery was rebuilt from PostgreSQL state.",
  },
  OPERATION_RETRY_SCHEDULED: {
    label: "Retry scheduled",
    tone: "warning",
    describe: (p) => `Transient failure${typeof p.code === "string" ? ` (${p.code})` : ""}; retrying with backoff.`,
  },
  LLM_JOURNAL_REPLAYED: {
    label: "Replayed from journal",
    tone: "success",
    describe: (p) => {
      const saved = (num(p.inputTokens) ?? 0) + (num(p.outputTokens) ?? 0);
      return `A committed LLM response was reused with no provider call${saved ? `, saving ${saved.toLocaleString("en-US")} tokens` : ""}.`;
    },
  },
  LLM_JOURNAL_ORPHANED: {
    label: "Response lost",
    tone: "warning",
    describe: () => "An in-flight LLM call's outcome was lost before it was journalled; the call was re-issued.",
  },
  LLM_CACHE_HIT: {
    label: "Cache hit",
    tone: "success",
    describe: (p) => {
      const saved = (num(p.inputTokens) ?? 0) + (num(p.outputTokens) ?? 0);
      return `An identical earlier request answered this call${saved ? `, saving ${saved.toLocaleString("en-US")} tokens` : ""}.`;
    },
  },
  EFFECT_OUTCOME_UNKNOWN: {
    label: "Effect outcome unknown",
    tone: "danger",
    describe: () => "A side effect may or may not have happened; the run waits for reconciliation instead of resending.",
  },
  EFFECT_RECONCILED_SUCCEEDED: { label: "Reconciled: succeeded", tone: "success", describe: () => "An operator confirmed the side effect happened." },
  EFFECT_RECONCILED_FAILED: { label: "Reconciled: failed", tone: "neutral", describe: () => "An operator confirmed the side effect did not happen." },
  RUN_BUDGET_EXCEEDED: {
    label: "Budget exceeded",
    tone: "danger",
    describe: (p) => `Billed usage reached the run budget${num(p.tokensUsed) !== null && num(p.maxTokens) !== null ? ` (${p.tokensUsed} of ${p.maxTokens} tokens)` : ""}; the run was stopped.`,
  },
  RUN_TIMED_OUT: { label: "Deadline exceeded", tone: "danger", describe: () => "The run passed its deadline and was stopped." },
};

export const recoveryEventTypes = new Set(Object.keys(recoveryTypes));

/** Recovery-relevant history events, oldest first, with a human label and one-line explanation. */
export function deriveRecoveryEvents(history: readonly HistoryLike[]): RecoveryEvent[] {
  return [...history]
    .filter((event) => recoveryEventTypes.has(event.type))
    .sort((a, b) => a.sequence - b.sequence)
    .map((event) => {
      const kind = recoveryTypes[event.type]!;
      const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : {};
      return {
        id: event.id,
        sequence: event.sequence,
        type: event.type,
        stepId: event.stepId,
        createdAt: event.createdAt,
        label: kind.label,
        description: kind.describe(payload),
        tone: kind.tone,
      };
    });
}

/** Tone for any history event type (recovery events keep their own tone). */
export function historyTone(type: string): Tone {
  const recovery = recoveryTypes[type];
  if (recovery) return recovery.tone;
  if (/FAILED|EXPIRED|REJECTED|CANCELLED/.test(type)) return "danger";
  if (/SUCCEEDED|APPROVED|CREATED/.test(type)) return "success";
  if (/RETRY|PAUSE|WAIT/.test(type)) return "warning";
  return "neutral";
}
