import type { Command } from "commander";
import { createRunSchema } from "@agentflow/shared";
import type { CliContext, ContextFactory } from "../context.js";
import { ExitWith, UsageError } from "../errors.js";
import { applySets, parseNonNegativeInt, parsePositiveInt, readJsonSource, shortId, validateRequest } from "../input.js";
import { formatRelative, parseDuration } from "../output/duration.js";
import { paintStatus } from "../output/style.js";
import { renderTable } from "../output/table.js";
import { aborted, confirm } from "../prompt.js";
import { renderRunDetail } from "../render/run.js";
import { resolveRunId } from "../resolve-id.js";
import type { RunDetail } from "../schemas.js";
import { watchRun, type WatchOptions } from "../watch.js";

const collect = (value: string, previous: string[]) => [...previous, value];

export function renderOptions(ctx: CliContext) {
  return { color: ctx.out.opts.color, now: ctx.io.now(), width: ctx.out.width, verbose: ctx.out.opts.verbose };
}

interface WatchFlags {
  interval: string;
  timeout?: string;
  untilTerminal: boolean;
}

function watchOptions(flags: WatchFlags): WatchOptions {
  const intervalMs = parseDuration(flags.interval);
  if (intervalMs < 1) throw new UsageError("--interval must be greater than zero");
  return {
    intervalMs,
    untilTerminal: flags.untilTerminal,
    ...(flags.timeout === undefined ? {} : { timeoutMs: parseDuration(flags.timeout) }),
  };
}

function addWatchFlags(command: Command): Command {
  return command
    .option("--interval <duration>", "poll interval", "2s")
    .option("--timeout <duration>", "give up after this long (exit 13)")
    .option("--until-terminal", "keep watching through WAITING_APPROVAL / NEEDS_ATTENTION", false);
}

async function finishWatch(ctx: CliContext, runId: string, flags: WatchFlags): Promise<void> {
  const code = await watchRun(ctx, runId, watchOptions(flags));
  if (code !== 0) throw new ExitWith(code);
}

export interface StartOptions {
  input?: string;
  set: string[];
  creationKey?: string;
  deadline?: string;
}

export async function startRun(ctx: CliContext, workflowVersionId: string, opts: StartOptions): Promise<RunDetail> {
  const base = opts.input === undefined ? {} : await readJsonSource(ctx.io, opts.input);
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    throw new UsageError("--input must contain a JSON object");
  }
  const body = validateRequest(createRunSchema, {
    workflowVersionId,
    input: applySets(base as Record<string, unknown>, opts.set),
    ...(opts.creationKey === undefined ? {} : { creationKey: opts.creationKey }),
    ...(opts.deadline === undefined ? {} : { deadlineMs: parseDuration(opts.deadline) }),
  });
  return ctx.client.createRun(body);
}

function registerSubResources(runs: Command, getContext: ContextFactory): void {
  runs.command("history <id>").description("show the run's audit events").action(async (raw: string) => {
    const ctx = await getContext();
    const body = await ctx.client.runHistory(await resolveRunId(ctx.client, raw));
    const now = ctx.io.now();
    ctx.out.data(body, {
      render: () => renderTable([
        { header: "SEQ", get: (e) => String(e.sequence) },
        { header: "WHEN", get: (e) => formatRelative(e.createdAt, now) },
        { header: "TYPE", get: (e) => e.type },
        { header: "STEP", get: (e) => (e.stepId ? shortId(e.stepId) : "-") },
      ], body.events, ctx.out.width),
      ids: () => body.events.map((e) => e.id),
    });
  });

  runs.command("attempts <id>").description("show step attempts").action(async (raw: string) => {
    const ctx = await getContext();
    const body = await ctx.client.runAttempts(await resolveRunId(ctx.client, raw));
    const now = ctx.io.now();
    ctx.out.data(body, {
      render: () => renderTable([
        { header: "STEP", get: (a) => a.stepKey, max: 32 },
        { header: "#", get: (a) => String(a.attemptNo) },
        { header: "EPOCH", get: (a) => String(a.epoch) },
        { header: "STATUS", get: (a) => paintStatus(a.status, ctx.out.opts.color) },
        { header: "WORKER", get: (a) => a.workerId, max: 24 },
        { header: "STARTED", get: (a) => formatRelative(a.startedAt, now) },
        { header: "ERROR", get: (a) => a.errorClass ?? "" },
      ], body.attempts, ctx.out.width),
      ids: () => body.attempts.map((a) => a.id),
    });
  });

  runs.command("usage <id>").description("show LLM token usage").action(async (raw: string) => {
    const ctx = await getContext();
    const body = await ctx.client.runUsage(await resolveRunId(ctx.client, raw));
    const now = ctx.io.now();
    ctx.out.data(body, {
      render: () => {
        const totalIn = body.usage.reduce((sum, u) => sum + u.inputTokens, 0);
        const totalOut = body.usage.reduce((sum, u) => sum + u.outputTokens, 0);
        const table = renderTable([
          { header: "PROVIDER", get: (u) => u.provider },
          { header: "MODEL", get: (u) => u.model },
          { header: "IN", get: (u) => String(u.inputTokens) },
          { header: "OUT", get: (u) => String(u.outputTokens) },
          { header: "WHEN", get: (u) => formatRelative(u.createdAt, now) },
        ], body.usage, ctx.out.width);
        return `${table}\n\ntotal: ${totalIn} in / ${totalOut} out`;
      },
    });
  });

  runs.command("sources <id>").description("show committed research sources").action(async (raw: string) => {
    const ctx = await getContext();
    const body = await ctx.client.runSources(await resolveRunId(ctx.client, raw));
    ctx.out.data(body, {
      render: () => renderTable([
        { header: "#", get: (s) => String(s.ordinal) },
        { header: "VENDOR", get: (s) => s.vendor },
        { header: "TITLE", get: (s) => s.title, max: 48 },
        { header: "URL", get: (s) => s.sourceUrl },
      ], body.sources, ctx.out.width),
      ids: () => body.sources.map((s) => s.id),
    });
  });

  runs.command("tools <id>").description("show tool executions (side effects)").action(async (raw: string) => {
    const ctx = await getContext();
    const body = await ctx.client.runToolExecutions(await resolveRunId(ctx.client, raw));
    ctx.out.data(body, {
      render: () => renderTable([
        { header: "ID", get: (t) => t.id },
        { header: "TOOL", get: (t) => t.toolName },
        { header: "EFFECT", get: (t) => t.effectClass },
        { header: "STATUS", get: (t) => paintStatus(t.invocationStatus, ctx.out.opts.color) },
        { header: "RECEIVER", get: (t) => t.receiverId ?? "-" },
      ], body.executions, ctx.out.width),
      ids: () => body.executions.map((t) => t.id),
    });
  });

  runs.command("ops <id>").description("show harness LLM/tool operations").action(async (raw: string) => {
    const ctx = await getContext();
    const body = await ctx.client.runHarnessOps(await resolveRunId(ctx.client, raw));
    ctx.out.data(body, {
      render: () => renderTable([
        { header: "ID", get: (o) => shortId(o.id) },
        { header: "STEP", get: (o) => shortId(o.stepId) },
        { header: "#", get: (o) => String(o.ordinal) },
        { header: "KIND", get: (o) => o.kind },
        { header: "TURN", get: (o) => (o.turn === null ? "-" : String(o.turn)) },
        { header: "STATUS", get: (o) => paintStatus(o.status, ctx.out.opts.color) },
      ], body.operations, ctx.out.width),
      ids: () => body.operations.map((o) => o.id),
    });
  });
}

export function registerRunCommands(program: Command, getContext: ContextFactory): Command {
  const runs = program.command("runs").description("start, inspect, watch and control runs");

  runs
    .command("list")
    .description("list your runs, newest first")
    .option("--limit <n>", "page size (1-100)", "50")
    .option("--offset <n>", "rows to skip", "0")
    .option("--status <status>", "only show runs with this public status (e.g. WAITING_APPROVAL)")
    .action(async (opts: { limit: string; offset: string; status?: string }) => {
      const limit = parsePositiveInt("--limit", opts.limit);
      if (limit > 100) throw new UsageError("--limit must be at most 100");
      const offset = parseNonNegativeInt("--offset", opts.offset);
      const ctx = await getContext();
      const body = await ctx.client.listRuns({ limit, offset });
      const wanted = opts.status?.toUpperCase();
      const rows = wanted ? body.runs.filter((r) => r.publicStatus === wanted) : body.runs;
      const now = ctx.io.now();
      ctx.out.data(wanted ? { ...body, runs: rows } : body, {
        render: () => {
          if (rows.length === 0) return wanted ? `No ${wanted} runs on this page` : "No runs yet";
          const table = renderTable([
            { header: "ID", get: (r) => shortId(r.id) },
            { header: "WORKFLOW", get: (r) => `${r.workflowName}@v${r.workflowVersion}`, max: 40 },
            { header: "STATUS", get: (r) => paintStatus(r.publicStatus, ctx.out.opts.color) },
            { header: "STEPS", get: (r) => `${r.completedStepCount}/${r.stepCount}` },
            { header: "TOKENS", get: (r) => `${r.inputTokens}/${r.outputTokens}` },
            { header: "CREATED", get: (r) => formatRelative(r.createdAt, now) },
          ], rows, ctx.out.width);
          const shown = offset + body.runs.length;
          return shown < body.total ? `${table}\n\nShowing ${offset + 1}-${shown} of ${body.total} (use --offset ${shown})` : table;
        },
        ids: () => rows.map((r) => r.id),
      });
    });

  const start = runs
    .command("start <workflowVersionId>")
    .description("start a run of a workflow version")
    .option("--input <file|->", "run input JSON object")
    .option("--set <key=value>", "set a top-level input field (repeatable; value parsed as JSON when valid)", collect, [])
    .option("--creation-key <key>", "idempotency key: repeating it returns the same run")
    .option("--deadline <duration>", "run deadline, e.g. 5m (default 5m)")
    .option("--watch", "watch the run after starting it (exit code reflects its outcome)", false);
  addWatchFlags(start).action(async (workflowVersionId: string, opts: StartOptions & WatchFlags & { watch: boolean }) => {
    const ctx = await getContext();
    if (opts.watch) watchOptions(opts);
    const run = await startRun(ctx, workflowVersionId, opts);
    if (opts.watch) {
      ctx.out.info(`Started run ${run.id}`);
      await finishWatch(ctx, run.id, opts);
      return;
    }
    ctx.out.data(run, {
      render: () => `Started run ${run.id} (${paintStatus(run.publicStatus, ctx.out.opts.color)})`,
      ids: () => [run.id],
    });
  });

  addWatchFlags(runs.command("watch <id>").description("follow a run until it finishes or needs attention"))
    .action(async (raw: string, opts: WatchFlags) => {
      const ctx = await getContext();
      watchOptions(opts);
      await finishWatch(ctx, await resolveRunId(ctx.client, raw), opts);
    });

  runs
    .command("show <id>")
    .description("show a run and its steps")
    .action(async (raw: string) => {
      const ctx = await getContext();
      const run = await ctx.client.getRun(await resolveRunId(ctx.client, raw));
      ctx.out.data(run, { render: () => renderRunDetail(run, renderOptions(ctx)), ids: () => [run.id] });
    });

  registerSubResources(runs, getContext);

  for (const command of ["pause", "resume"] as const) {
    runs
      .command(`${command} <id>`)
      .description(`${command} a run`)
      .action(async (raw: string) => {
        const ctx = await getContext();
        const run = await ctx.client.controlRun(await resolveRunId(ctx.client, raw), command);
        ctx.out.data(run, {
          render: () => `Run ${run.id}: ${paintStatus(run.publicStatus, ctx.out.opts.color)}`,
          ids: () => [run.id],
        });
      });
  }

  runs
    .command("cancel <id>")
    .description("cancel a run")
    .option("-y, --yes", "do not ask for confirmation", false)
    .action(async (raw: string, opts: { yes: boolean }) => {
      const ctx = await getContext();
      const id = await resolveRunId(ctx.client, raw);
      if (!(await confirm(ctx.io, `cancel run ${shortId(id)}`, opts))) throw aborted();
      const run = await ctx.client.controlRun(id, "cancel");
      ctx.out.data(run, {
        render: () => `Run ${run.id}: ${paintStatus(run.publicStatus, ctx.out.opts.color)}`,
        ids: () => [run.id],
      });
    });

  return runs;
}
