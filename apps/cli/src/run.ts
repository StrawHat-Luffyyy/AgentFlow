import { Command, CommanderError } from "commander";
import { CliError, ExitCode } from "./errors.js";
import type { CliIO } from "./io.js";
import { VERSION } from "./version.js";

export function buildProgram(io: CliIO): Command {
  const program = new Command("agentflow")
    .description("Operate AgentFlow durable workflow runs from the terminal")
    .version(VERSION, "--version", "print the CLI version")
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
  return program;
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
