import { Command, CommanderError } from "commander";
import { registerAuthCommands } from "./commands/auth.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerWorkflowCommands } from "./commands/workflows.js";
import { createContext, type CliContext, type GlobalFlags } from "./context.js";
import { CliError, ExitCode } from "./errors.js";
import type { CliIO } from "./io.js";
import { VERSION } from "./version.js";

export function buildProgram(io: CliIO): Command {
  const program = new Command("agentflow")
    .description("Operate AgentFlow durable workflow runs from the terminal")
    .option("--profile <name>", "config profile to use")
    .option("--url <url>", "AgentFlow API base URL")
    .option("--json", "print raw JSON responses", false)
    .option("--no-color", "disable colored output")
    .option("-q, --quiet", "print only IDs / minimal output", false)
    .option("-v, --verbose", "log requests to stderr", false)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text),
    });
  program.showHelpAfterError("(run agentflow --help for usage)");
  // `--version` is handled in run() so subcommands (workflows publish --version <n>) can reuse the flag.
  program.addHelpText("after", "\nRun `agentflow --version` to print the CLI version.");
  let context: Promise<CliContext> | undefined;
  const getContext = () => (context ??= createContext(io, globalFlags(program)));
  registerAuthCommands(program, getContext);
  registerConfigCommands(program, getContext);
  registerStatusCommand(program, getContext);
  registerWorkflowCommands(program, getContext);
  return program;
}

function globalFlags(program: Command): GlobalFlags {
  const opts = program.opts<{
    profile?: string; url?: string; json: boolean; color: boolean; quiet: boolean; verbose: boolean;
  }>();
  return {
    ...(opts.profile === undefined ? {} : { profile: opts.profile }),
    ...(opts.url === undefined ? {} : { url: opts.url }),
    json: opts.json,
    color: opts.color,
    quiet: opts.quiet,
    verbose: opts.verbose,
  };
}

function reportError(error: unknown, io: CliIO, json: boolean, verbose: boolean): number {
  if (error instanceof CliError) {
    io.stderr.write(`Error: ${error.message}\n`);
    if (verbose && error.details !== undefined) io.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    if (json) {
      const status = (error as { status?: number }).status;
      io.stderr.write(`${JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          ...(status === undefined ? {} : { status }),
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      })}\n`);
    }
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.stderr.write(`Unexpected error: ${message}\n`);
  if (verbose && error instanceof Error && error.stack) io.stderr.write(`${error.stack}\n`);
  return ExitCode.ERROR;
}

export async function run(argv: string[], io: CliIO): Promise<number> {
  if (argv[0] === "--version" || argv[0] === "-V") {
    io.stdout.write(`${VERSION}\n`);
    return ExitCode.OK;
  }
  const program = buildProgram(io);
  try {
    await program.parseAsync(argv, { from: "user" });
    return ExitCode.OK;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return ExitCode.OK;
      return ExitCode.USAGE;
    }
    const opts = program.opts<{ json?: boolean; verbose?: boolean }>();
    return reportError(error, io, opts.json === true, opts.verbose === true);
  }
}
