import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Queue, type Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../apps/api/src/app.ts";
import type { Credential } from "../../apps/api/src/auth.ts";
import { createOutboxDispatcher } from "../../apps/api/src/outbox.ts";
import { redisConnection } from "../../apps/api/src/redis.ts";
import { createOperationWorker } from "../../apps/worker/src/worker.ts";
import { createDatabase, migrate, type Database } from "@agentflow/db";
import { AgentHarness, ProviderRegistry, ToolRegistry } from "@agentflow/harness";
import { listAvailableProviders, recordWorkerHeartbeat } from "../../packages/runtime/src/index.ts";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://agentflow:agentflow@localhost:5432/agentflow_test";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const suffix = randomUUID();
const TOKEN = `providers-${suffix}`;
const ownerId = `providers-owner-${suffix}`;
const credentials: Credential[] = [{
  id: ownerId,
  tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
  roles: ["release-manager", "research-reviewer", "operator"],
}];

function assertTestDatabaseUrl(connectionString: string): void {
  const databaseName = new URL(connectionString).pathname.slice(1);
  if (!/(?:_|-)test$/.test(databaseName)) throw new Error(`Refusing to use non-test database "${databaseName}".`);
}

let database: Database;
let queue: Queue;
let server: Server;
let baseUrl: string;
const queueName = `providers-test-${suffix}`;

async function call(path: string, init?: RequestInit & { token?: string | null }): Promise<Response> {
  const token = init?.token === undefined ? TOKEN : init.token;
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers },
  });
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await call(path, init);
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function deterministicVersion(name: string) {
  const workflow = await json<{ id: string }>("/workflows", { method: "POST", body: JSON.stringify({ name }) });
  const version = await json<{ id: string }>(`/workflows/${workflow.id}/versions`, {
    method: "POST",
    body: JSON.stringify({ version: 1, definition: { steps: [{ key: "finalize", kind: "DETERMINISTIC", handler: "finalize" }] } }),
  });
  return { workflowId: workflow.id, versionId: version.id };
}

beforeAll(async () => {
  assertTestDatabaseUrl(databaseUrl);
  database = createDatabase(databaseUrl);
  await migrate(database);
  queue = new Queue(queueName, { connection: redisConnection(redisUrl) });
  server = createApp(database, queue, credentials).listen(0);
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await queue?.close();
  await database?.end();
});

describe("worker heartbeats", () => {
  it("upserts one row per worker, keeping started_at and advancing last_seen_at", async () => {
    const workerId = `hb-${suffix}-upsert`;
    await recordWorkerHeartbeat(database, { workerId, providers: [{ name: "a", models: [] }] });
    const first = await database.query<{ started_at: Date; last_seen_at: Date }>(
      "SELECT started_at, last_seen_at FROM worker_heartbeats WHERE worker_id = $1", [workerId],
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await recordWorkerHeartbeat(database, { workerId, providers: [{ name: "b", models: ["m"] }] });
    const second = await database.query<{ started_at: Date; last_seen_at: Date; providers: unknown }>(
      "SELECT started_at, last_seen_at, providers FROM worker_heartbeats WHERE worker_id = $1", [workerId],
    );
    expect(second.rowCount).toBe(1);
    expect(second.rows[0]!.started_at.getTime()).toBe(first.rows[0]!.started_at.getTime());
    expect(second.rows[0]!.last_seen_at.getTime()).toBeGreaterThan(first.rows[0]!.last_seen_at.getTime());
    expect(second.rows[0]!.providers).toEqual([{ name: "b", models: ["m"] }]);
  });

  it("aggregates fresh workers and excludes stale ones", async () => {
    const gemini = `gemini-${suffix}`;
    const scripted = `scripted-${suffix}`;
    await recordWorkerHeartbeat(database, { workerId: `hb-${suffix}-a`, providers: [{ name: gemini, models: ["m1"] }] });
    await recordWorkerHeartbeat(database, {
      workerId: `hb-${suffix}-b`, providers: [{ name: gemini, models: ["m2"] }, { name: scripted, models: ["s"] }],
    });
    await recordWorkerHeartbeat(database, { workerId: `hb-${suffix}-stale`, providers: [{ name: gemini, models: ["m3"] }] });
    await database.query(
      "UPDATE worker_heartbeats SET last_seen_at = now() - interval '31 seconds' WHERE worker_id = $1", [`hb-${suffix}-stale`],
    );
    const result = await listAvailableProviders(database);
    expect(result.providers.find((p) => p.name === gemini)).toMatchObject({ models: ["m1", "m2"], workerCount: 2 });
    expect(result.providers.find((p) => p.name === scripted)).toMatchObject({ models: ["s"], workerCount: 1 });
    expect(result.workers).toBeGreaterThanOrEqual(2);
  });

  it("serves GET /runtime/providers to authenticated callers only", async () => {
    expect((await call("/runtime/providers", { token: null })).status).toBe(401);
    const body = await json<{ workers: number; providers: Array<{ name: string; lastSeenAt: string }> }>("/runtime/providers");
    expect(typeof body.workers).toBe("number");
    expect(body.providers.find((p) => p.name === `gemini-${suffix}`)?.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("heartbeats are advisory only", () => {
  it("queues a run with no fresh heartbeats and executes it when a worker appears later", async () => {
    const { versionId } = await deterministicVersion(`advisory-${suffix}`);
    const run = await json<{ id: string; publicStatus: string }>("/runs", {
      method: "POST",
      body: JSON.stringify({ workflowVersionId: versionId, input: { note: "queued before any worker" } }),
    });
    expect(run.publicStatus).toBe("QUEUED");

    const connection = redisConnection(redisUrl);
    let worker: Worker | undefined;
    const dispatcher = createOutboxDispatcher(database, queue, 25);
    try {
      worker = createOperationWorker({
        database,
        connection,
        workerId: `late-worker-${suffix}`,
        leaseMs: 15_000,
        concurrency: 1,
        queueName,
        harness: new AgentHarness(new ProviderRegistry(), new ToolRegistry()),
      });
      await worker.waitUntilReady();
      dispatcher.start();
      const deadline = Date.now() + 15_000;
      let status = run.publicStatus;
      while (Date.now() < deadline && status !== "SUCCEEDED") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = (await json<{ publicStatus: string }>(`/runs/${run.id}`)).publicStatus;
      }
      expect(status).toBe("SUCCEEDED");
    } finally {
      await dispatcher.stop();
      await worker?.close();
    }
  }, 30_000);

  it("keeps worker_heartbeats out of every execution path", async () => {
    const runtime = await readFile(new URL("../../packages/runtime/src/index.ts", import.meta.url), "utf8");
    const readers = runtime.split(/\nexport /)
      .filter((chunk) => chunk.includes("worker_heartbeats"))
      .map((chunk) => /^async function (\w+)/.exec(chunk)?.[1] ?? chunk.slice(0, 40));
    expect(readers.sort()).toEqual(["listAvailableProviders", "recordWorkerHeartbeat"]);
    const worker = await readFile(new URL("../../apps/worker/src/worker.ts", import.meta.url), "utf8");
    expect(worker).not.toContain("worker_heartbeats");
    const app = await readFile(new URL("../../apps/api/src/app.ts", import.meta.url), "utf8");
    expect(app).not.toContain("worker_heartbeats");
  });
});
