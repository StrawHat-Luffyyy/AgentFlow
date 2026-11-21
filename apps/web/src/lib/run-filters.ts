// Runs-list filters live in the URL so a filtered view can be shared and survives reloads.
import type { RunFilters } from "../api.js";

export const statusPresets = {
  all: { label: "All statuses", statuses: [] as string[] },
  active: { label: "Active", statuses: ["QUEUED", "RUNNING", "RETRY_WAIT", "PAUSE_REQUESTED", "CANCEL_REQUESTED"] },
  attention: { label: "Needs attention", statuses: ["WAITING_APPROVAL", "NEEDS_ATTENTION", "PAUSED"] },
  succeeded: { label: "Succeeded", statuses: ["SUCCEEDED"] },
  failed: { label: "Failed", statuses: ["FAILED", "TIMED_OUT", "BUDGET_EXCEEDED"] },
  cancelled: { label: "Cancelled", statuses: ["CANCELLED"] },
} as const;
export type StatusPreset = keyof typeof statusPresets;

export const rangePresets = {
  any: { label: "Any time", hours: null },
  "24h": { label: "Last 24 hours", hours: 24 },
  "7d": { label: "Last 7 days", hours: 24 * 7 },
  "30d": { label: "Last 30 days", hours: 24 * 30 },
} as const;
export type RangePreset = keyof typeof rangePresets;

export interface RunListQuery {
  status: StatusPreset;
  workflow: string;
  range: RangePreset;
}

const isStatus = (value: string | null): value is StatusPreset => value !== null && value in statusPresets;
const isRange = (value: string | null): value is RangePreset => value !== null && value in rangePresets;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unknown or malformed values fall back to "show everything", never to an error. */
export function parseRunListQuery(params: URLSearchParams): RunListQuery {
  const status = params.get("status");
  const range = params.get("range");
  const workflow = params.get("workflow") ?? "";
  return {
    status: isStatus(status) ? status : "all",
    workflow: UUID.test(workflow) ? workflow : "",
    range: isRange(range) ? range : "any",
  };
}

/** Writes only non-default values, so the plain /runs URL means "no filters". */
export function serializeRunListQuery(query: RunListQuery, base = new URLSearchParams()): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const key of ["status", "workflow", "range"]) params.delete(key);
  if (query.status !== "all") params.set("status", query.status);
  if (query.workflow) params.set("workflow", query.workflow);
  if (query.range !== "any") params.set("range", query.range);
  return params;
}

/** API filters for a query; `now` is injected so the result is testable. */
export function toApiFilters(query: RunListQuery, now: number): RunFilters {
  const hours = rangePresets[query.range].hours;
  return {
    ...(statusPresets[query.status].statuses.length ? { status: [...statusPresets[query.status].statuses] } : {}),
    ...(query.workflow ? { workflowId: query.workflow } : {}),
    ...(hours === null ? {} : { from: new Date(now - hours * 3_600_000).toISOString() }),
  };
}

export function isFiltered(query: RunListQuery): boolean {
  return query.status !== "all" || query.workflow !== "" || query.range !== "any";
}
