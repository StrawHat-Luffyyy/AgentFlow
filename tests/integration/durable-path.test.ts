import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../../apps/api/src/app.ts";
import { createOutboxDispatcher } from "../../apps/api/src/outbox.ts";
import { redisConnection } from "../../apps/api/src/redis.ts";
import { createOperationWorker } from "../../apps/worker/src/worker.ts";
import { createDatabase, migrate, type Database } from "@agentflow/db";
import { defaultWorkflowDefinition } from "@agentflow/shared";
import { Queue, QueueEvents, type Worker } from "bullmq";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://agentflow:agentflow@localhost:5432/agentflow_test";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const testQueueName = "agentflow-test-operations";

function assertTestDatabaseUrl(connectionString: string): void {
  const databaseName = new URL(connectionString).pathname.slice(1);
  if (!/(?:_|-)test$/.test(databaseName)) {
    throw new Error(
      `Refusing to truncate non-test database "${databaseName}". TEST_DATABASE_URL must end in _test or -test.`,
    );
  }
}

let database: Database;
let queue: Queue;
let queueEvents: QueueEvents;
let worker: Worker;
let dispatcher: ReturnType<typeof createOutboxDispatcher>;
let server: Server;
let baseUrl: string;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function waitForSucceeded(runId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await request<{ lifecycle: string }>(`/runs/${runId}`);
    if (run.lifecycle === "SUCCEEDED") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Run did not succeed before test deadline");
}

beforeAll(async () => {
  assertTestDatabaseUrl(databaseUrl);
  database = createDatabase(databaseUrl);
  await migrate(database);
  await database.query(`
    TRUNCATE audit_events, outbox, checkpoints, step_attempts, workflow_steps,
      workflow_runs, workflow_versions, workflows CASCADE
  `);

  const connection = redisConnection(redisUrl);
  queue = new Queue(testQueueName, { connection });
  await queue.obliterate({ force: true });
  queueEvents = new QueueEvents(testQueueName, { connection });
  await queueEvents.waitUntilReady();
  worker = createOperationWorker({
    database,
    connection,
    workerId: "integration-worker",
    leaseMs: 15_000,
    concurrency: 2,
    queueName: testQueueName,
  });
  await worker.waitUntilReady();
  dispatcher = createOutboxDispatcher(database, queue, 25);
  dispatcher.start();

  const app = createApp(database, queue);
  server = app.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await worker?.close();
  await queueEvents?.close();
  await dispatcher?.stop();
  await database?.end();
});

describe("durable API → outbox → BullMQ → worker path", () => {
  it("commits both deterministic operations and ignores duplicate delivery", async () => {
    const workflow = await request<{ id: string }>("/workflows", {
      method: "POST",
      body: JSON.stringify({ name: "integration-workflow", description: "Durable path" }),
    });
    const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ version: 1, definition: defaultWorkflowDefinition }),
    });
    const created = await request<{
      id: string;
      lifecycle: string;
      stateRevision: number;
      steps: Array<{ id: string; status: string; dispatchGeneration: number }>;
    }>("/runs", {
      method: "POST",
      body: JSON.stringify({
        workflowVersionId: version.id,
        input: { topic: "durability", count: 2 },
        creationKey: "integration-run-1",
      }),
    });

    expect(created.lifecycle).toBe("OPEN");
    expect(created.stateRevision).toBe(0);
    expect(created.steps).toHaveLength(1);
    expect(created.steps[0]?.status).toBe("READY");

    await waitForSucceeded(created.id);
    const completed = await request<{
      lifecycle: string;
      stateRevision: number;
      steps: Array<{
        id: string;
        nodeKey: string;
        status: string;
        attemptCount: number;
        acceptedOutput: unknown;
      }>;
      checkpoint: { revision: number; cursor: string | null };
    }>(`/runs/${created.id}`);

    expect(completed.lifecycle).toBe("SUCCEEDED");
    expect(completed.stateRevision).toBe(2);
    expect(completed.steps.map((step) => step.nodeKey)).toEqual(["generate-summary", "finalize"]);
    expect(completed.steps.every((step) => step.status === "SUCCEEDED")).toBe(true);
    expect(completed.steps.every((step) => step.attemptCount === 1)).toBe(true);
    expect(completed.checkpoint).toMatchObject({ revision: 2, cursor: null });

    const firstStep = completed.steps[0];
    expect(firstStep).toBeDefined();
    const duplicate = await queue.add(
      testQueueName,
      {
        runId: created.id,
        operationId: firstStep!.id,
        workflowVersionId: version.id,
        dispatchGeneration: 1,
      },
      { jobId: `duplicate-test-${firstStep!.id}` },
    );
    const duplicateResult = await duplicate.waitUntilFinished(queueEvents, 5_000);
    expect(duplicateResult).toMatchObject({ skipped: true, reason: "not-eligible" });

    const persisted = await database.query<{
      checkpoints: string;
      outbox_rows: string;
      attempts: string;
      accepted_results: string;
    }>(
      `SELECT
         (SELECT count(*) FROM checkpoints WHERE run_id = $1) AS checkpoints,
         (SELECT count(*) FROM outbox WHERE run_id = $1) AS outbox_rows,
         (SELECT count(*) FROM step_attempts sa JOIN workflow_steps ws ON ws.id = sa.step_id WHERE ws.run_id = $1) AS attempts,
         (SELECT count(*) FROM workflow_steps WHERE run_id = $1 AND accepted_output_json IS NOT NULL) AS accepted_results`,
      [created.id],
    );
    expect(persisted.rows[0]).toEqual({
      checkpoints: "3",
      outbox_rows: "2",
      attempts: "2",
      accepted_results: "2",
    });

    const history = await request<{ events: Array<{ type: string }> }>(
      `/runs/${created.id}/history`,
    );
    expect(history.events.map((event) => event.type)).toEqual([
      "RUN_CREATED",
      "OPERATION_SUCCEEDED",
      "OPERATION_SUCCEEDED",
    ]);
  }, 20_000);
});
