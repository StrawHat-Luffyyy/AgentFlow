import type { CliIO } from "../io.js";

export interface OutputOptions {
  json: boolean;
  quiet: boolean;
  color: boolean;
  verbose: boolean;
}

/** stdout carries data only; everything else goes to stderr. */
export class Output {
  constructor(private readonly io: CliIO, readonly opts: OutputOptions) {}

  get width(): number {
    return this.io.stdout.columns ?? 100;
  }

  get tty(): boolean {
    return this.io.stdout.isTTY === true;
  }

  data(value: unknown, human: { render: () => string; ids?: () => string[] }): void {
    if (this.opts.json) {
      this.io.stdout.write(`${JSON.stringify(value, null, this.tty ? 2 : 0)}\n`);
    } else if (this.opts.quiet && human.ids) {
      const ids = human.ids();
      if (ids.length > 0) this.io.stdout.write(`${ids.join("\n")}\n`);
    } else {
      const text = human.render();
      if (text !== "") this.io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    }
  }

  info(message: string): void {
    if (!this.opts.quiet) this.io.stderr.write(`${message}\n`);
  }

  warn(message: string): void {
    this.io.stderr.write(`${message}\n`);
  }

  debug(message: string): void {
    if (this.opts.verbose) this.io.stderr.write(`${message}\n`);
  }
}
