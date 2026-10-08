import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { CliIO } from "./io.js";
import { run } from "./run.js";

const controller = new AbortController();
let trapped = 0;
process.on("SIGINT", () => {
  // Only commands that trap interrupts (runs watch) get a graceful abort; a second
  // Ctrl-C, or any Ctrl-C elsewhere (prompts, stdin reads, hung requests), exits now.
  if (trapped === 0 || controller.signal.aborted) process.exit(130);
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
  trapInterrupts: () => {
    trapped += 1;
    return () => { trapped -= 1; };
  },
};

process.exitCode = await run(process.argv.slice(2), io);
