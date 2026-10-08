import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { CliIO } from "./io.js";
import { run } from "./run.js";

const controller = new AbortController();
process.on("SIGINT", () => {
  // A second Ctrl-C exits immediately even if a command ignores the abort.
  if (controller.signal.aborted) process.exit(130);
  controller.abort();
});

const io: CliIO = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  platform: process.platform,
  homedir: homedir(),
  fetch: globalThis.fetch,
  sleep: async (ms, signal) => {
    await delay(ms, undefined, signal ? { signal } : {}).catch(() => undefined);
  },
  now: () => Date.now(),
  signal: controller.signal,
};

process.exitCode = await run(process.argv.slice(2), io);
