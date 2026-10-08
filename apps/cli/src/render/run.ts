import { formatRelative } from "../output/duration.js";
import { renderFields } from "../output/fields.js";
import { paintStatus } from "../output/style.js";
import { renderTable } from "../output/table.js";
import type { RunDetail } from "../schemas.js";

export interface RenderOptions {
  color: boolean;
  now: number;
  width: number;
  verbose: boolean;
}

function time(value: string, opts: RenderOptions): string {
  return opts.verbose ? `${formatRelative(value, opts.now)} (${value})` : formatRelative(value, opts.now);
}

export function summarizeFailure(failure: unknown): string | undefined {
  if (failure === null || failure === undefined) return undefined;
  if (typeof failure === "object") {
    const record = failure as { errorClass?: unknown; message?: unknown; code?: unknown };
    const parts = [record.errorClass, record.code, record.message].filter((part) => typeof part === "string");
    if (parts.length > 0) return parts.join(": ");
  }
  return JSON.stringify(failure);
}

export function renderRunDetail(run: RunDetail, opts: RenderOptions): string {
  const fields: Array<[string, string]> = [
    ["run", run.id],
    ["status", paintStatus(run.publicStatus, opts.color)],
    ["version", run.workflowVersionId],
    ["created", time(run.createdAt, opts)],
    run.finishedAt ? ["finished", time(run.finishedAt, opts)] : ["deadline", time(run.deadlineAt, opts)],
  ];
  const failure = summarizeFailure(run.failure);
  if (failure) fields.push(["failure", failure]);
  const steps = renderTable([
    { header: "#", get: (step) => String(step.position + 1) },
    { header: "KEY", get: (step) => step.nodeKey, max: 32 },
    { header: "KIND", get: (step) => step.kind },
    { header: "STATUS", get: (step) => paintStatus(step.status, opts.color) },
    { header: "ATTEMPTS", get: (step) => `${step.attemptCount}/${step.maxAttempts}` },
    { header: "UPDATED", get: (step) => formatRelative(step.completedAt ?? step.createdAt, opts.now) },
  ], run.steps, opts.width);
  return `${renderFields(fields)}\n\n${steps}`;
}
