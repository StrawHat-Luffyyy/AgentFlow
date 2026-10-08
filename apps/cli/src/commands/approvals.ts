import { createHash, randomUUID } from "node:crypto";
import type { Command } from "commander";
import { approvalDecisionSchema, canonicalJson } from "@agentflow/shared";
import type { ApiClient } from "../api-client.js";
import type { CliContext, ContextFactory } from "../context.js";
import { CliError, ExitCode, UsageError } from "../errors.js";
import { shortId, validateRequest } from "../input.js";
import { formatRelative } from "../output/duration.js";
import { renderFields } from "../output/fields.js";
import { renderTable } from "../output/table.js";
import { aborted, confirm } from "../prompt.js";
import { MIN_PREFIX, resolveRunId } from "../resolve-id.js";
import type { Approval } from "../schemas.js";

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function stepKey(approval: Approval): string {
  const proposal = approval.proposal as { stepKey?: unknown } | null;
  return typeof proposal?.stepKey === "string" ? proposal.stepKey : shortId(approval.stepId);
}

export async function findPendingApproval(client: ApiClient, id: string): Promise<Approval> {
  const wanted = id.toLowerCase();
  if (wanted.length < MIN_PREFIX) {
    throw new UsageError(`Approval ID must be a full UUID or a prefix of at least ${MIN_PREFIX} characters`);
  }
  const { approvals } = await client.listApprovals();
  const exact = approvals.find((candidate) => candidate.id === wanted);
  const matches = exact ? [exact] : approvals.filter((candidate) => candidate.id.startsWith(wanted));
  if (matches.length > 1) {
    const listed = matches.slice(0, 5).map((candidate) => `  ${candidate.id}`).join("\n");
    throw new UsageError(`Approval ID prefix ${id} is ambiguous; it matches:\n${listed}`);
  }
  if (!matches[0]) {
    throw new CliError(
      `Approval ${id} not found, not pending, or not assigned to your roles`,
      ExitCode.NOT_FOUND,
      "NOT_FOUND",
    );
  }
  return matches[0];
}

/** The API signs `sha256(canonicalJson(value))`; refuse to decide on content that does not match. */
export function verifyApprovalHashes(approval: Approval): void {
  if (sha256(approval.proposal) !== approval.proposalHash || sha256(approval.payload) !== approval.payloadHash) {
    throw new CliError(
      `Approval ${approval.id} content does not match its hashes; refusing to sign`,
      ExitCode.ERROR,
      "HASH_MISMATCH",
    );
  }
}

function renderApproval(approval: Approval, now: number): string {
  return [
    renderFields([
      ["approval", approval.id],
      ["run", approval.runId],
      ["step", stepKey(approval)],
      ["status", approval.status],
      ["role", approval.reviewerRole],
      ["expires", formatRelative(approval.expiresAt, now)],
      ["proposal hash", approval.proposalHash],
      ["payload hash", approval.payloadHash],
    ]),
    "",
    "proposal:",
    JSON.stringify(approval.proposal, null, 2),
    "",
    "payload:",
    JSON.stringify(approval.payload, null, 2),
  ].join("\n");
}

async function decide(ctx: CliContext, id: string, decision: "APPROVE" | "REJECT", yes: boolean): Promise<void> {
  const approval = await findPendingApproval(ctx.client, id);
  verifyApprovalHashes(approval);
  ctx.io.stderr.write(`${renderApproval(approval, ctx.io.now())}\n\n`);
  const verb = decision === "APPROVE" ? "approve" : "reject";
  if (!(await confirm(ctx.io, `${verb} approval ${shortId(approval.id)} for step ${stepKey(approval)}`, { yes }))) {
    throw aborted();
  }
  const body = validateRequest(approvalDecisionSchema, {
    decisionRequestId: randomUUID(),
    decision,
    proposalHash: approval.proposalHash,
    payloadHash: approval.payloadHash,
  });
  const result = await ctx.client.decideApproval(approval.id, body, approval.reviewerRole);
  ctx.out.data(result, {
    render: () => `${decision === "APPROVE" ? "Approved" : "Rejected"} approval ${approval.id}`,
    ids: () => [approval.id],
  });
}

export function registerApprovalCommands(program: Command, getContext: ContextFactory): void {
  const approvals = program.command("approvals").description("review pending human approvals");

  approvals
    .command("list")
    .description("list approvals waiting on one of your roles")
    .option("--run <id>", "only approvals for this run (UUID or 8+ char prefix)")
    .action(async (opts: { run?: string }) => {
      const ctx = await getContext();
      const runId = opts.run === undefined ? undefined : await resolveRunId(ctx.client, opts.run);
      const body = await ctx.client.listApprovals(runId === undefined ? {} : { runId });
      const now = ctx.io.now();
      ctx.out.data(body, {
        render: () => (body.approvals.length === 0 ? "No pending approvals" : renderTable([
          { header: "ID", get: (a) => shortId(a.id) },
          { header: "RUN", get: (a) => shortId(a.runId) },
          { header: "STEP", get: (a) => stepKey(a), max: 32 },
          { header: "ROLE", get: (a) => a.reviewerRole },
          { header: "EXPIRES", get: (a) => formatRelative(a.expiresAt, now) },
          { header: "CREATED", get: (a) => formatRelative(a.createdAt, now) },
        ], body.approvals, ctx.out.width)),
        ids: () => body.approvals.map((a) => a.id),
      });
    });

  approvals
    .command("show <id>")
    .description("show what a pending approval would sign")
    .action(async (id: string) => {
      const ctx = await getContext();
      const approval = await findPendingApproval(ctx.client, id);
      ctx.out.data(approval, { render: () => renderApproval(approval, ctx.io.now()), ids: () => [approval.id] });
    });

  for (const [command, decision] of [["approve", "APPROVE"], ["reject", "REJECT"]] as const) {
    approvals
      .command(`${command} <id>`)
      .description(`${command} a pending approval after reviewing its content`)
      .option("-y, --yes", "do not ask for confirmation", false)
      .action(async (id: string, opts: { yes: boolean }) => {
        await decide(await getContext(), id, decision, opts.yes);
      });
  }
}
