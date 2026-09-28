import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../../apps/api/src/app.ts";
import { createOutboxDispatcher } from "../../apps/api/src/outbox.ts";
import { redisConnection } from "../../apps/api/src/redis.ts";
import {
  createOperationWorker,
  processOperationJob,
} from "../../apps/worker/src/worker.ts";
import { createDatabase, migrate, type Database } from "@agentflow/db";
import { defaultWorkflowDefinition } from "@agentflow/shared";
import {
  claimOperation,
  completeOperation,
  executeDeterministicOperation,
  renewOperationLease,
  repairScheduling,
} from "../../packages/runtime/src/index.ts";
import { Queue, QueueEvents, type Job, type Worker } from "bullmq";
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

  it("abandons an expired lease, fences the stale worker, and dispatches a new epoch", async () => {
    await worker.pause(true);
    try {
      const workflow = await request<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ name: "lease-recovery-workflow", description: "Lease recovery" }),
      });
      const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
        method: "POST",
        body: JSON.stringify({ version: 1, definition: defaultWorkflowDefinition }),
      });
      const created = await request<{
        id: string;
        steps: Array<{ id: string; dispatchGeneration: number }>;
      }>("/runs", {
        method: "POST",
        body: JSON.stringify({
          workflowVersionId: version.id,
          input: { topic: "lease recovery" },
          creationKey: "integration-lease-recovery",
        }),
      });
      const step = created.steps[0]!;
      const initialJob = {
        runId: created.id,
        operationId: step.id,
        workflowVersionId: version.id,
        dispatchGeneration: step.dispatchGeneration,
      };
      const staleClaim = await claimOperation(database, initialJob, "stale-worker", 1_000);
      expect(staleClaim).not.toBeNull();

      const renewed = await renewOperationLease(database, staleClaim!, 5_000);
      expect(renewed).toBe(true);
      const heartbeat = await database.query<{ extended: boolean }>(
        `SELECT lease_expires_at > now() + interval '4 seconds' AS extended
         FROM workflow_steps WHERE id = $1`,
        [step.id],
      );
      expect(heartbeat.rows[0]?.extended).toBe(true);
      await database.query(
        "UPDATE workflow_steps SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [step.id],
      );
      expect(await renewOperationLease(database, staleClaim!, 5_000)).toBe(false);

      const repaired = await repairScheduling(database, 10_000);
      expect(repaired).toEqual({ expiredLeases: 1, recoveredDispatches: 0 });
      await expect(
        completeOperation(database, staleClaim!, executeDeterministicOperation(staleClaim!)),
      ).rejects.toThrow("lease fencing");

      const recoveredStep = await database.query<{
        status: string;
        dispatch_generation: number;
        abandoned_attempts: string;
      }>(
        `SELECT ws.status, ws.dispatch_generation,
           (SELECT count(*) FROM step_attempts sa
            WHERE sa.step_id = ws.id AND sa.status = 'ABANDONED') AS abandoned_attempts
         FROM workflow_steps ws WHERE ws.id = $1`,
        [step.id],
      );
      expect(recoveredStep.rows[0]).toMatchObject({
        status: "READY",
        dispatch_generation: 2,
        abandoned_attempts: "1",
      });

      const replacement = await claimOperation(
        database,
        { ...initialJob, dispatchGeneration: 2 },
        "replacement-worker",
        15_000,
      );
      expect(replacement?.leaseEpoch).toBe(2);
      await completeOperation(database, replacement!, executeDeterministicOperation(replacement!));

      const events = await request<{ events: Array<{ type: string }> }>(
        `/runs/${created.id}/history`,
      );
      expect(events.events.map((event) => event.type)).toContain("LEASE_EXPIRED");
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("recreates missing and expired dispatches that did not lead to a claim", async () => {
    await worker.pause(true);
    try {
      const workflow = await request<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ name: "dispatch-recovery-workflow", description: "Dispatch recovery" }),
      });
      const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
        method: "POST",
        body: JSON.stringify({ version: 1, definition: defaultWorkflowDefinition }),
      });
      const created = await request<{ id: string; steps: Array<{ id: string }> }>("/runs", {
        method: "POST",
        body: JSON.stringify({
          workflowVersionId: version.id,
          input: { topic: "stranded dispatch" },
          creationKey: "integration-dispatch-recovery",
        }),
      });
      const step = created.steps[0]!;
      const publishDeadline = Date.now() + 5_000;
      while (Date.now() < publishDeadline) {
        const current = await database.query<{ published: boolean }>(
          "SELECT published_at IS NOT NULL AS published FROM outbox WHERE step_id = $1 AND generation = 1",
          [step.id],
        );
        if (current.rows[0]?.published) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await database.query(
        `UPDATE outbox
         SET published_at = now() - interval '2 seconds'
         WHERE step_id = $1 AND generation = 1`,
        [step.id],
      );

      const repaired = await repairScheduling(database, 1_000);
      expect(repaired).toEqual({ expiredLeases: 0, recoveredDispatches: 1 });
      const recovered = await database.query<{
        dispatch_generation: number;
        generations: number[];
      }>(
        `SELECT ws.dispatch_generation,
           ARRAY(SELECT generation FROM outbox WHERE step_id = ws.id ORDER BY generation) AS generations
         FROM workflow_steps ws WHERE ws.id = $1`,
        [step.id],
      );
      expect(recovered.rows[0]).toMatchObject({ dispatch_generation: 2, generations: [1, 2] });

      const secondRepair = await repairScheduling(database, 1_000);
      expect(secondRepair).toEqual({ expiredLeases: 0, recoveredDispatches: 0 });

      const missing = await request<{ id: string; steps: Array<{ id: string }> }>("/runs", {
        method: "POST",
        body: JSON.stringify({
          workflowVersionId: version.id,
          input: { topic: "missing dispatch" },
          creationKey: "integration-missing-dispatch-recovery",
        }),
      });
      const missingStep = missing.steps[0]!;
      await database.query("DELETE FROM outbox WHERE step_id = $1", [missingStep.id]);

      const missingRepair = await repairScheduling(database, 1_000);
      expect(missingRepair).toEqual({ expiredLeases: 0, recoveredDispatches: 1 });
      const restored = await database.query<{
        dispatch_generation: number;
        outbox_rows: string;
      }>(
        `SELECT ws.dispatch_generation,
           (SELECT count(*) FROM outbox WHERE step_id = ws.id) AS outbox_rows
         FROM workflow_steps ws WHERE ws.id = $1`,
        [missingStep.id],
      );
      expect(restored.rows[0]).toEqual({ dispatch_generation: 2, outbox_rows: "1" });
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("settles a worker execution failure through expired-lease recovery", async () => {
    await worker.pause(true);
    try {
      const workflow = await request<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ name: "worker-failure-workflow", description: "Worker failure" }),
      });
      const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
        method: "POST",
        body: JSON.stringify({ version: 1, definition: defaultWorkflowDefinition }),
      });
      const created = await request<{
        id: string;
        steps: Array<{ id: string; dispatchGeneration: number }>;
      }>("/runs", {
        method: "POST",
        body: JSON.stringify({
          workflowVersionId: version.id,
          input: { topic: "worker failure" },
          creationKey: "integration-worker-failure",
        }),
      });
      const step = created.steps[0]!;
      await database.query("UPDATE workflow_steps SET handler = 'forced-failure' WHERE id = $1", [step.id]);
      const job = {
        data: {
          runId: created.id,
          operationId: step.id,
          workflowVersionId: version.id,
          dispatchGeneration: step.dispatchGeneration,
        },
      } as Job;

      await expect(
        processOperationJob(database, "failing-worker", 1_000, job, 250),
      ).rejects.toThrow("Unsupported deterministic handler");
      const failedDelivery = await database.query<{ status: string; attempts: string }>(
        `SELECT ws.status,
           (SELECT count(*) FROM step_attempts sa
            WHERE sa.step_id = ws.id AND sa.status = 'RUNNING') AS attempts
         FROM workflow_steps ws WHERE ws.id = $1`,
        [step.id],
      );
      expect(failedDelivery.rows[0]).toEqual({ status: "RUNNING", attempts: "1" });

      await database.query(
        "UPDATE workflow_steps SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [step.id],
      );
      expect(await repairScheduling(database, 10_000)).toEqual({
        expiredLeases: 1,
        recoveredDispatches: 0,
      });
      const settled = await database.query<{ status: string; abandoned: string }>(
        `SELECT ws.status,
           (SELECT count(*) FROM step_attempts sa
            WHERE sa.step_id = ws.id AND sa.status = 'ABANDONED') AS abandoned
         FROM workflow_steps ws WHERE ws.id = $1`,
        [step.id],
      );
      expect(settled.rows[0]).toEqual({ status: "READY", abandoned: "1" });
      await database.query("UPDATE workflow_steps SET handler = 'generate-summary' WHERE id = $1", [step.id]);
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("allows only one concurrent repair to reclaim an expired lease", async () => {
    await worker.pause(true);
    try {
      const workflow = await request<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ name: "concurrent-repair-workflow", description: "Repair race" }),
      });
      const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
        method: "POST",
        body: JSON.stringify({ version: 1, definition: defaultWorkflowDefinition }),
      });
      const created = await request<{
        id: string;
        steps: Array<{ id: string; dispatchGeneration: number }>;
      }>("/runs", {
        method: "POST",
        body: JSON.stringify({
          workflowVersionId: version.id,
          input: { topic: "repair race" },
          creationKey: "integration-concurrent-repair",
        }),
      });
      const step = created.steps[0]!;
      const claim = await claimOperation(
        database,
        {
          runId: created.id,
          operationId: step.id,
          workflowVersionId: version.id,
          dispatchGeneration: step.dispatchGeneration,
        },
        "race-worker",
        1_000,
      );
      expect(claim).not.toBeNull();
      await database.query(
        "UPDATE workflow_steps SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [step.id],
      );

      const repairs = await Promise.all([
        repairScheduling(database, 10_000),
        repairScheduling(database, 10_000),
      ]);
      expect(repairs.reduce((sum, result) => sum + result.expiredLeases, 0)).toBe(1);
      const persisted = await database.query<{
        dispatch_generation: number;
        replacement_dispatches: string;
        abandoned_attempts: string;
        expiry_events: string;
      }>(
        `SELECT ws.dispatch_generation,
           (SELECT count(*) FROM outbox WHERE step_id = ws.id AND generation = 2) AS replacement_dispatches,
           (SELECT count(*) FROM step_attempts sa
            WHERE sa.step_id = ws.id AND sa.status = 'ABANDONED') AS abandoned_attempts,
           (SELECT count(*) FROM audit_events ae
            WHERE ae.step_id = ws.id AND ae.type = 'LEASE_EXPIRED') AS expiry_events
         FROM workflow_steps ws WHERE ws.id = $1`,
        [step.id],
      );
      expect(persisted.rows[0]).toEqual({
        dispatch_generation: 2,
        replacement_dispatches: "1",
        abandoned_attempts: "1",
        expiry_events: "1",
      });
    } finally {
      await worker.resume();
    }
  }, 20_000);
});
