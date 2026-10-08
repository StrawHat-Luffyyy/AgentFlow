import type { CliContext } from "./context.js";
import { ApiError, CliError, ExitCode } from "./errors.js";
import { renderRunDetail } from "./render/run.js";
import type { HistoryEvent, RunDetail } from "./schemas.js";

const MAX_BACKOFF_MS = 30_000;

export interface WatchOptions {
  intervalMs: number;
  timeoutMs?: number;
  untilTerminal: boolean;
}

const TERMINAL: Record<string, number> = {
  SUCCEEDED: ExitCode.OK,
  FAILED: ExitCode.RUN_FAILED,
  CANCELLED: ExitCode.RUN_CANCELLED,
  TIMED_OUT: ExitCode.RUN_TIMED_OUT,
};
const WAITING = new Set(["WAITING_APPROVAL", "NEEDS_ATTENTION"]);

/** Exit code for a stopping state, or undefined to keep watching. */
export function stopCode(publicStatus: string, untilTerminal: boolean): number | undefined {
  if (publicStatus in TERMINAL) return TERMINAL[publicStatus];
  if (!untilTerminal && WAITING.has(publicStatus)) return ExitCode.RUN_WAITING;
  return undefined;
}

function isTransient(error: unknown): boolean {
  if (error instanceof ApiError) return error.status >= 500;
  return error instanceof CliError && error.code === "NETWORK";
}

function eventLine(event: HistoryEvent, run: RunDetail): string {
  const step = event.stepId ? run.steps.find((s) => s.id === event.stepId)?.nodeKey ?? event.stepId.slice(0, 8) : "";
  return `${event.createdAt}  ${event.type}${step ? `  ${step}` : ""}`.trimEnd();
}

/** Polls a run until it reaches a stopping state; returns the CLI exit code. */
export async function watchRun(ctx: CliContext, runId: string, opts: WatchOptions): Promise<number> {
  const { io, out, client } = ctx;
  const live = !out.opts.json && out.tty;
  const appendMode = !out.opts.json && !out.tty;
  const deadline = opts.timeoutMs === undefined ? undefined : io.now() + opts.timeoutMs;
  const seen = new Set<string>();
  let drawnLines = 0;
  let failures = 0;

  for (;;) {
    if (io.signal.aborted) {
      out.warn(`Stopped watching; run ${runId} is unaffected`);
      return ExitCode.INTERRUPTED;
    }
    let run: RunDetail;
    let events: HistoryEvent[] = [];
    try {
      run = await client.getRun(runId);
      if (appendMode) events = (await client.runHistory(runId)).events;
      failures = 0;
    } catch (error) {
      if (!isTransient(error)) throw error;
      failures += 1;
      const delay = Math.min(opts.intervalMs * 2 ** failures, MAX_BACKOFF_MS);
      out.warn(`Retrying in ${Math.round(delay / 1000)}s: ${(error as Error).message}`);
      await io.sleep(delay, io.signal);
      continue;
    }

    if (live) {
      const frame = renderRunDetail(run, {
        color: out.opts.color, now: io.now(), width: out.width, verbose: out.opts.verbose,
      });
      if (drawnLines > 0) io.stdout.write(`\x1b[${drawnLines}A\x1b[0J`);
      io.stdout.write(`${frame}\n`);
      drawnLines = frame.split("\n").length;
    } else if (appendMode) {
      for (const event of events) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        io.stdout.write(`${eventLine(event, run)}\n`);
      }
    }

    const code = stopCode(run.publicStatus, opts.untilTerminal);
    if (code !== undefined) {
      if (out.opts.json) out.data(run, { render: () => "" });
      else if (appendMode) io.stdout.write(`Run ${run.id} ${run.publicStatus}\n`);
      return code;
    }
    if (deadline !== undefined && io.now() >= deadline) {
      out.warn(`Timed out waiting for run ${runId} (still ${run.publicStatus})`);
      if (out.opts.json) out.data(run, { render: () => "" });
      return ExitCode.WATCH_TIMEOUT;
    }
    await io.sleep(opts.intervalMs, io.signal);
  }
}
