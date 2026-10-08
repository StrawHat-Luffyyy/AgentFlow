import { CliError, ExitCode, UsageError } from "./errors.js";
import type { CliIO } from "./io.js";

/** Reads one line from stdin, leaving any remaining input buffered. */
export function readLine(io: CliIO): Promise<string> {
  const stream = io.stdin;
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.pause();
    };
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      cleanup();
      const rest = buffer.slice(index + 1);
      if (rest !== "") stream.unshift(Buffer.from(rest));
      resolve(buffer.slice(0, index).replace(/\r$/, ""));
    };
    const onEnd = () => {
      cleanup();
      resolve(buffer.replace(/\r$/, ""));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    stream.resume();
  });
}

/** Reads stdin to the end (for `--input -` style arguments). */
export async function readStdin(io: CliIO): Promise<string> {
  let text = "";
  for await (const chunk of io.stdin) text += chunk.toString();
  return text;
}

export async function ask(io: CliIO, question: string): Promise<string> {
  io.stderr.write(question);
  return (await readLine(io)).trim();
}

/** Prompts with echo disabled; requires a TTY. */
export function askSecret(io: CliIO, question: string): Promise<string> {
  const stream = io.stdin;
  io.stderr.write(question);
  stream.setRawMode?.(true);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: CliError) => {
      stream.off("data", onData);
      stream.setRawMode?.(false);
      stream.pause();
      io.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString()) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") return finish(new CliError("Interrupted", ExitCode.INTERRUPTED, "INTERRUPTED"));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stream.on("data", onData);
    stream.resume();
  });
}

/**
 * Asks before an irreversible action. `action` is phrased as a verb phrase,
 * e.g. "cancel run 1234abcd".
 */
export async function confirm(io: CliIO, action: string, opts: { yes: boolean }): Promise<boolean> {
  if (opts.yes) return true;
  if (!io.stdin.isTTY) {
    throw new UsageError(`Refusing to ${action} without --yes in a non-interactive session`);
  }
  const answer = await ask(io, `${action.charAt(0).toUpperCase()}${action.slice(1)}? [y/N] `);
  return /^y(es)?$/i.test(answer);
}

export function aborted(): CliError {
  return new CliError("Aborted", ExitCode.ERROR, "ABORTED");
}
