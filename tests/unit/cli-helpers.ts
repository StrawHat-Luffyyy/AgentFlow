import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import type { CliIO } from "../../apps/cli/src/io.js";

export interface FakeIO {
  io: CliIO;
  stdout(): string;
  stderr(): string;
  feed(text: string): void;
  endInput(): void;
  sleeps: number[];
  abort(): void;
  trapped(): number;
}

export interface FakeIOOptions {
  env?: Record<string, string | undefined>;
  stdoutTTY?: boolean;
  stdinTTY?: boolean;
  columns?: number;
  platform?: NodeJS.Platform;
  homedir?: string;
  now?: () => number;
  onSleep?: (ms: number) => void | Promise<void>;
  fetch?: typeof fetch;
}

export function fakeIO(options: FakeIOOptions = {}): FakeIO {
  const stdout = Object.assign(new PassThrough(), {
    isTTY: options.stdoutTTY ?? false,
    columns: options.columns ?? 100,
  });
  const stderr = Object.assign(new PassThrough(), { isTTY: options.stdoutTTY ?? false });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: options.stdinTTY ?? false,
    setRawMode: (_on: boolean) => stdin,
  });
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
  const sleeps: number[] = [];
  const controller = new AbortController();
  let trapped = 0;
  const io: CliIO = {
    stdout,
    stderr,
    stdin,
    env: options.env ?? {},
    platform: options.platform ?? "linux",
    homedir: options.homedir ?? "/home/test",
    fetch: options.fetch ?? globalThis.fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      await options.onSleep?.(ms);
    },
    now: options.now ?? (() => Date.parse("2026-10-08T12:00:00.000Z")),
    signal: controller.signal,
    trapInterrupts: () => {
      trapped += 1;
      return () => { trapped -= 1; };
    },
  };
  return {
    io,
    stdout: () => out,
    stderr: () => err,
    feed: (text: string) => { stdin.write(text); },
    endInput: () => { stdin.end(); },
    sleeps,
    abort: () => controller.abort(),
    trapped: () => trapped,
  };
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string | string[]>;
}

export interface FakeApi {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startFakeApi(
  handler: (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>,
): Promise<FakeApi> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", "http://fake");
    const recorded: RecordedRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    requests.push(recorded);
    const response = await handler(recorded);
    for (const [name, value] of Object.entries(response.headers ?? {})) res.setHeader(name, value);
    res.statusCode = response.status;
    if (response.body === undefined) {
      res.end();
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(response.body));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/** A fake IO pre-authenticated against `apiUrl` via env, with an isolated config file. */
export async function authedIO(apiUrl: string, options: FakeIOOptions = {}): Promise<FakeIO & { dir: string }> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "agentflow-cli-"));
  const fake = fakeIO({
    ...options,
    env: { AGENTFLOW_CONFIG: join(dir, "config.json"), AGENTFLOW_URL: apiUrl, AGENTFLOW_TOKEN: "test-token", ...options.env },
  });
  return { ...fake, dir };
}
