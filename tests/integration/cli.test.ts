import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Queue, type Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../apps/api/src/app.ts";
import type { Credential } from "../../apps/api/src/auth.ts";
import { createOutboxDispatcher } from "../../apps/api/src/outbox.ts";
import { redisConnection } from "../../apps/api/src/redis.ts";
import { run } from "../../apps/cli/src/run.ts";
import { createOperationWorker } from "../../apps/worker/src/worker.ts";
import { createDatabase, migrate, type Database } from "@agentflow/db";
import { AgentHarness, ProviderRegistry, ToolRegistry } from "@agentflow/harness";
import { ScriptedResearchProvider } from "@agentflow/research";
import { fakeIO } from "../unit/cli-helpers.ts";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://agentflow:agentflow@localhost:5432/agentflow_test";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const queueName = "agentflow-cli-test-operations";

const suffix = randomUUID();
const TOKEN = `cli-e2e-token-${suffix}`;
const credentials: Credential[] = [{
  id: `cli-e2e-${suffix}`,
  tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
  roles: ["release-manager", "research-reviewer", "operator"],
}];

function assertTestDatabaseUrl(connectionString: string): void {
  const databaseName = new URL(connectionString).pathname.slice(1);
  if (!/(?:_|-)test$/.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}".`);
  }
}

let database: Database;
let queue: Queue;
let worker: Worker;
let dispatcher: ReturnType<typeof createOutboxDispatcher>;
let server: Server;
let baseUrl: string;
let configDir: string;

/** Runs the CLI in-process against the real API with an isolated config file. */
async function cli(args: string[], stdin?: string) {
  const fake = fakeIO({
    env: { AGENTFLOW_CONFIG: join(configDir, "config.json") },
    now: () => Date.now(),
    onSleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  if (stdin !== undefined) {
    fake.feed(stdin);
    fake.endInput();
  }
  const code = await run(args, fake.io);
  return { code, stdout: fake.stdout(), stderr: fake.stderr() };
}

beforeAll(async () => {
  assertTestDatabaseUrl(databaseUrl);
  database = createDatabase(databaseUrl);
  await migrate(database);
  const connection = redisConnection(redisUrl);
  queue = new Queue(queueName, { connection });
  await queue.obliterate({ force: true });
  worker = createOperationWorker({
    database,
    connection,
    workerId: "cli-e2e-worker",
    leaseMs: 15_000,
    concurrency: 2,
    queueName,
    harness: new AgentHarness(new ProviderRegistry().register(new ScriptedResearchProvider()), new ToolRegistry()),
  });
  await worker.waitUntilReady();
  dispatcher = createOutboxDispatcher(database, queue, 25);
  dispatcher.start();
  server = createApp(database, queue, credentials).listen(0);
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configDir = await mkdtemp(join(tmpdir(), "agentflow-cli-e2e-"));
}, 30_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await dispatcher?.stop();
  await worker?.close();
  await queue?.close();
  await database?.end();
});

describe("agentflow CLI end to end", () => {
  it("logs in, publishes, runs, approves and watches a workflow to completion", async () => {
    const login = await cli(["login", "--token", "--url", baseUrl], `${TOKEN}\n`);
    expect(login.code, login.stderr).toBe(0);
    const whoami = await cli(["whoami", "--json"]);
    expect(JSON.parse(whoami.stdout).id).toBe(credentials[0]!.id);

    const created = await cli(["workflows", "create", "--name", `cli-e2e-${suffix}`, "-q"]);
    expect(created.code, created.stderr).toBe(0);
    const workflowId = created.stdout.trim();
    const definitionFile = join(configDir, "definition.json");
    await writeFile(definitionFile, JSON.stringify({
      steps: [
        { key: "review", kind: "APPROVAL", handler: "approval", reviewerRole: "release-manager", expiresAfterMs: 60_000 },
        { key: "finalize", kind: "DETERMINISTIC", handler: "finalize" },
      ],
    }));
    const published = await cli(["workflows", "publish", workflowId, "--version", "1", "--definition", definitionFile, "-q"]);
    expect(published.code, published.stderr).toBe(0);
    const versionId = published.stdout.trim();
    const shown = await cli(["workflows", "show", workflowId, "--json"]);
    expect(JSON.parse(shown.stdout).versions).toHaveLength(1);

    const started = await cli(["runs", "start", versionId, "--set", 'release="r1"', "-q"]);
    expect(started.code, started.stderr).toBe(0);
    const runId = started.stdout.trim();
    const waiting = await cli(["runs", "watch", runId.slice(0, 8), "--interval", "100ms", "--timeout", "20s"]);
    expect(waiting.code, waiting.stderr).toBe(12);

    const pending = await cli(["approvals", "list", "--json"]);
    const approval = (JSON.parse(pending.stdout) as { approvals: Array<{ id: string; runId: string }> })
      .approvals.find((candidate) => candidate.runId === runId);
    expect(approval).toBeDefined();
    const approved = await cli(["approvals", "approve", approval!.id, "--yes"]);
    expect(approved.code, approved.stderr).toBe(0);

    const finished = await cli(["runs", "watch", runId, "--interval", "100ms", "--timeout", "20s"]);
    expect(finished.code, finished.stderr).toBe(0);
    const detail = await cli(["runs", "show", runId, "--json"]);
    expect(JSON.parse(detail.stdout).publicStatus).toBe("SUCCEEDED");

    const cancel = await cli(["runs", "cancel", runId, "--yes"]);
    expect(cancel.code).toBe(5);

    expect((await cli(["logout"])).code).toBe(0);
    expect((await cli(["whoami"])).code).toBe(3);
  }, 60_000);
});
