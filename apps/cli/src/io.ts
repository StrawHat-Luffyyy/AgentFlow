import type { Readable, Writable } from "node:stream";

/** Every process-level dependency the CLI touches, injectable for tests. */
export interface CliIO {
  stdout: Writable & { isTTY?: boolean; columns?: number };
  stderr: Writable & { isTTY?: boolean };
  stdin: Readable & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown };
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir: string;
  fetch: typeof fetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  signal: AbortSignal;
}
