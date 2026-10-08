import type { Command } from "commander";
import type { ContextFactory } from "../context.js";
import { CliError, ExitCode } from "../errors.js";

export function registerStatusCommand(program: Command, getContext: ContextFactory): void {
  program
    .command("status")
    .description("check API, database and queue health")
    .action(async () => {
      const ctx = await getContext();
      const health = await ctx.client.health();
      let ready;
      try {
        ready = await ctx.client.ready();
      } catch (error) {
        ctx.out.data({ url: ctx.settings.baseUrl, health }, { render: () => `api ${health.status}` });
        const reason = error instanceof Error ? error.message : String(error);
        throw new CliError(`API at ${ctx.settings.baseUrl} is up but not ready: ${reason}`, ExitCode.ERROR, "NOT_READY");
      }
      ctx.out.data({ url: ctx.settings.baseUrl, health, ready }, {
        render: () => [`api ${health.status}`, `database ${ready.database}`, `queue ${ready.queue}`].join("\n"),
      });
    });
}
