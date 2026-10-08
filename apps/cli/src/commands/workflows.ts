import type { Command } from "commander";
import { createWorkflowSchema, createWorkflowVersionSchema } from "@agentflow/shared";
import type { ContextFactory } from "../context.js";
import { parsePositiveInt, readJsonSource, shortId, validateRequest } from "../input.js";
import { formatRelative, parseDuration } from "../output/duration.js";
import { renderFields } from "../output/fields.js";
import { renderTable } from "../output/table.js";

export function registerWorkflowCommands(program: Command, getContext: ContextFactory): void {
  const workflows = program.command("workflows").description("list, inspect and publish workflows");

  workflows
    .command("list")
    .description("list your workflows")
    .action(async () => {
      const ctx = await getContext();
      const body = await ctx.client.listWorkflows();
      const now = ctx.io.now();
      ctx.out.data(body, {
        render: () => (body.workflows.length === 0 ? "No workflows yet — try `agentflow workflows reference`" : renderTable([
          { header: "ID", get: (w) => shortId(w.id) },
          { header: "NAME", get: (w) => w.name, max: 48 },
          { header: "LATEST", get: (w) => (w.latestVersion === null ? "(none)" : `v${w.latestVersion}`) },
          { header: "VERSIONS", get: (w) => String(w.versionCount) },
          { header: "CREATED", get: (w) => formatRelative(w.createdAt, now) },
        ], body.workflows, ctx.out.width)),
        ids: () => body.workflows.map((w) => w.id),
      });
    });

  workflows
    .command("show <id>")
    .description("show a workflow and its versions")
    .action(async (id: string) => {
      const ctx = await getContext();
      const workflow = await ctx.client.getWorkflow(id);
      const now = ctx.io.now();
      ctx.out.data(workflow, {
        render: () => {
          const header = renderFields([
            ["id", workflow.id],
            ["name", workflow.name],
            ["description", workflow.description || "(none)"],
            ["created", formatRelative(workflow.createdAt, now)],
          ]);
          const versions = workflow.versions.length === 0 ? "No versions published" : renderTable([
            { header: "VERSION", get: (v) => `v${v.version}` },
            { header: "ID", get: (v) => v.id },
            { header: "STEPS", get: (v) => String(v.stepCount) },
            { header: "CREATED", get: (v) => formatRelative(v.createdAt, now) },
          ], workflow.versions, ctx.out.width);
          return `${header}\n\n${versions}`;
        },
        ids: () => workflow.versions.map((v) => v.id),
      });
    });

  workflows
    .command("create")
    .description("create a workflow")
    .requiredOption("--name <name>", "workflow name (unique per owner)")
    .option("--description <text>", "description", "")
    .action(async (opts: { name: string; description: string }) => {
      const body = validateRequest(createWorkflowSchema, { name: opts.name, description: opts.description });
      const ctx = await getContext();
      const workflow = await ctx.client.createWorkflow(body);
      ctx.out.data(workflow, {
        render: () => `Created workflow ${workflow.name} (${workflow.id})`,
        ids: () => [workflow.id],
      });
    });

  workflows
    .command("publish <workflowId>")
    .description("publish a new immutable version of a workflow")
    .requiredOption("--version <n>", "version number")
    .option("--definition <file|->", "workflow definition JSON (default: the built-in default definition)")
    .action(async (workflowId: string, opts: { version: string; definition?: string }) => {
      const ctx = await getContext();
      const version = parsePositiveInt("--version", opts.version);
      const definition = opts.definition === undefined ? undefined : await readJsonSource(ctx.io, opts.definition);
      const body = validateRequest(createWorkflowVersionSchema, {
        version,
        ...(definition === undefined ? {} : { definition }),
      });
      const created = await ctx.client.publishVersion(workflowId, body);
      ctx.out.data(created, {
        render: () => `Published version ${created.version} of workflow ${created.workflowId} (${created.id})`,
        ids: () => [created.id],
      });
    });

  workflows
    .command("reference")
    .description("create (or reuse) the cloud-comparison reference workflow")
    .option("--mode <mode>", "scripted or live", "scripted")
    .option("--provider <provider>", "LLM provider (live mode)")
    .option("--model <model>", "LLM model (live mode)")
    .option("--reviewer-role <role>", "role allowed to approve publication")
    .option("--approval-expires <duration>", "approval expiry, e.g. 24h")
    .action(async (opts: { mode: string; provider?: string; model?: string; reviewerRole?: string; approvalExpires?: string }) => {
      const body: Record<string, unknown> = { mode: opts.mode };
      if (opts.provider !== undefined) body.provider = opts.provider;
      if (opts.model !== undefined) body.model = opts.model;
      if (opts.reviewerRole !== undefined) body.reviewerRole = opts.reviewerRole;
      if (opts.approvalExpires !== undefined) body.approvalExpiresAfterMs = parseDuration(opts.approvalExpires);
      const ctx = await getContext();
      const setup = await ctx.client.setupReference(body);
      ctx.out.data(setup, {
        render: () => [
          `Reference workflow ${setup.workflowName} v${setup.version} ${setup.created ? "created" : "already existed"}`,
          `workflow version id: ${setup.workflowVersionId}`,
          `start a run: agentflow runs start ${setup.workflowVersionId} --input <file>`,
        ].join("\n"),
        ids: () => [setup.workflowVersionId],
      });
    });
}
