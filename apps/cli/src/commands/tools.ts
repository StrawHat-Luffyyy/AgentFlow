import type { Command } from "commander";
import { reconciliationDecisionSchema } from "@agentflow/shared";
import type { ContextFactory } from "../context.js";
import { UsageError } from "../errors.js";
import { readJsonSource, shortId, validateRequest } from "../input.js";
import { aborted, confirm } from "../prompt.js";

interface ReconcileFlags {
  succeeded?: boolean;
  fail?: boolean;
  receiver?: string;
  receipt?: string;
  yes: boolean;
}

export function registerToolCommands(program: Command, getContext: ContextFactory): void {
  const tools = program.command("tools").description("resolve ambiguous tool side effects (operator role)");

  tools
    .command("reconcile <toolExecutionId>")
    .description("record the real outcome of an UNKNOWN tool execution")
    .option("--succeeded", "the external write happened (requires --receiver and --receipt)")
    .option("--fail", "the external write did not happen; fail the step permanently")
    .option("--receiver <id>", "receiver-side identifier of the completed write")
    .option("--receipt <file|->", "receipt JSON object proving the write")
    .option("-y, --yes", "do not ask for confirmation", false)
    .action(async (id: string, opts: ReconcileFlags) => {
      if (Boolean(opts.succeeded) === Boolean(opts.fail)) {
        throw new UsageError("Pass exactly one of --succeeded or --fail");
      }
      const ctx = await getContext();
      const receipt = opts.receipt === undefined ? undefined : await readJsonSource(ctx.io, opts.receipt);
      const body = validateRequest(reconciliationDecisionSchema, opts.succeeded
        ? {
          resolution: "CONFIRM_SUCCEEDED",
          ...(opts.receiver === undefined ? {} : { receiverId: opts.receiver }),
          ...(receipt === undefined ? {} : { receipt }),
        }
        : { resolution: "FAIL_FINAL" });
      const action = opts.succeeded ? "confirm success of" : "permanently fail";
      if (!(await confirm(ctx.io, `${action} tool execution ${shortId(id)}`, { yes: opts.yes }))) throw aborted();
      const result = await ctx.client.reconcile(id, body);
      ctx.out.data(result, {
        render: () => `Tool execution ${id} reconciled: ${body.resolution}`,
        ids: () => [id],
      });
    });
}
