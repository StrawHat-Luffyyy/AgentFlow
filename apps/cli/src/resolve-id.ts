import type { ApiClient } from "./api-client.js";
import { CliError, ExitCode, UsageError } from "./errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX = /^[0-9a-f-]{8,}$/i;
export const MIN_PREFIX = 8;
const PAGE = 100;

/** Accepts a full run UUID or a unique prefix of at least 8 characters. */
export async function resolveRunId(client: ApiClient, raw: string): Promise<string> {
  if (UUID.test(raw)) return raw.toLowerCase();
  if (!PREFIX.test(raw)) {
    throw new UsageError(`Run ID must be a full UUID or a prefix of at least ${MIN_PREFIX} characters`);
  }
  const prefix = raw.toLowerCase();
  const matches: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await client.listRuns({ limit: PAGE, offset });
    for (const run of page.runs) if (run.id.startsWith(prefix)) matches.push(run.id);
    if (page.runs.length === 0 || offset + page.runs.length >= page.total) break;
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new CliError(`Run ${raw} not found (or not owned by you)`, ExitCode.NOT_FOUND, "NOT_FOUND");
  }
  const listed = matches.slice(0, 5).map((id) => `  ${id}`).join("\n");
  throw new UsageError(`Run ID prefix ${raw} is ambiguous; it matches:\n${listed}${matches.length > 5 ? "\n  …" : ""}`);
}
