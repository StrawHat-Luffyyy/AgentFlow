import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../../apps/api/src/app.ts";
import { createOutboxDispatcher } from "../../apps/api/src/outbox.ts";
import { redisConnection } from "../../apps/api/src/redis.ts";
import {
  createOperationWorker,
  processOperationJob,
} from "../../apps/worker/src/worker.ts";
import { createDatabase, migrate, type Database } from "@agentflow/db";
import {
  AgentHarness,
  DeterministicFakeProvider,
  ProviderRegistry,
  ToolRegistry,
  type LLMResponse,
} from "@agentflow/harness";
import { defaultWorkflowDefinition } from "@agentflow/shared";
import { ScriptedResearchProvider, fixedSourceContentHash } from "@agentflow/research";
import {
  beginHarnessLlmOperation,
  claimOperation,
  completeHarnessLlmOperation,
  completeOperation,
  controlRun,
  executeDeterministicOperation,
  executeToolOperation,
  prepareToolExecution,
  publishToControlledReceiver,
  renewOperationLease,
  repairScheduling,
  settleOperationFailure,
} from "../../packages/runtime/src/index.ts";
import { Queue, QueueEvents, type Job, type Worker } from "bullmq";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

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

async function rawRequest(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

async function restartApi(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server = createApp(database, queue).listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function createApprovalRun(name: string, expiresAfterMs = 60_000) {
  const workflow = await request<{ id: string }>("/workflows", {
    method: "POST",
    body: JSON.stringify({ name, description: "Approval semantics" }),
  });
  const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
    method: "POST",
    body: JSON.stringify({
      version: 1,
      definition: {
        steps: [
          {
            key: "review",
            kind: "APPROVAL",
            handler: "approval",
            reviewerRole: "release-manager",
            expiresAfterMs,
          },
          { key: "finalize", kind: "DETERMINISTIC", handler: "finalize" },
        ],
      },
    }),
  });
  const run = await request<{
    id: string;
    publicStatus: string;
    steps: Array<{ id: string; status: string }>;
  }>("/runs", {
    method: "POST",
    body: JSON.stringify({
      workflowVersionId: version.id,
      input: { release: name, target: "production" },
      creationKey: `${name}-run`,
    }),
  });
  const approvals = await request<{
    approvals: Array<{
      id: string;
      status: string;
      proposalHash: string;
      payloadHash: string;
      reviewerRole: string;
    }>;
  }>(`/runs/${run.id}/approvals`);
  return { version, run, approval: approvals.approvals[0]! };
}

async function createPublicationRun(
  name: string,
  effectClass: "RECEIVER_IDEMPOTENT_WRITE" | "UNSAFE_WRITE",
) {
  const workflow = await request<{ id: string }>("/workflows", {
    method: "POST",
    body: JSON.stringify({ name, description: "Publication side effects" }),
  });
  const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
    method: "POST",
    body: JSON.stringify({
      version: 1,
      definition: {
        steps: [{
          key: "publish",
          kind: "TOOL",
          handler: "publish-report",
          toolVersion: "1",
          effectClass,
        }],
      },
    }),
  });
  const run = await request<{
    id: string;
    publicStatus: string;
    steps: Array<{
      id: string;
      status: string;
      dispatchGeneration: number;
      effectClass: string;
    }>;
  }>("/runs", {
    method: "POST",
    body: JSON.stringify({
      workflowVersionId: version.id,
      input: { report: `report:${name}`, target: "controlled://publications/main" },
      creationKey: `${name}-run`,
      retryPolicy: {
        maxAttempts: 3,
        initialBackoffMs: 0,
        multiplier: 1,
        maxBackoffMs: 0,
      },
    }),
  });
  return { version, run };
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

async function waitForPublicStatus(runId: string, expected: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await request<{ publicStatus: string }>(`/runs/${runId}`);
    if (run.publicStatus === expected) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run did not reach ${expected} before test deadline`);
}

beforeAll(async () => {
  assertTestDatabaseUrl(databaseUrl);
  database = createDatabase(databaseUrl);
  await migrate(database);
  await database.query(`
    TRUNCATE research_sources, tool_executions, idempotency_records, controlled_publication_effects,
      approvals, audit_events, outbox, checkpoints, step_attempts, workflow_steps,
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
    harness: new AgentHarness(
      new ProviderRegistry().register(new ScriptedResearchProvider()),
      new ToolRegistry(),
    ),
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
  it("lists run summaries and exposes step attempts for operations inspection", async () => {
    const workflow = await request<{ id: string }>("/workflows", {
      method: "POST",
      body: JSON.stringify({ name: "observability-api", description: "Milestone 7 inspection" }),
    });
    const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ version: 1, definition: defaultWorkflowDefinition }),
    });
    const created = await request<{ id: string }>("/runs", {
      method: "POST",
      body: JSON.stringify({
        workflowVersionId: version.id,
        input: { milestone: 7 },
        creationKey: "observability-api-run",
      }),
    });
    await waitForSucceeded(created.id);

    const listed = await request<{
      runs: Array<{
        id: string;
        workflowName: string;
        publicStatus: string;
        stepCount: number;
        completedStepCount: number;
        attemptCount: number;
      }>;
      total: number;
      limit: number;
      offset: number;
    }>("/runs?limit=10&offset=0");
    expect(listed.total).toBeGreaterThanOrEqual(1);
    expect(listed.runs).toContainEqual(expect.objectContaining({
      id: created.id,
      workflowName: "observability-api",
      publicStatus: "SUCCEEDED",
      stepCount: 2,
      completedStepCount: 2,
      attemptCount: 2,
    }));

    const inspected = await request<{
      attempts: Array<{ stepKey: string; attemptNo: number; status: string }>;
    }>(`/runs/${created.id}/attempts`);
    expect(inspected.attempts).toHaveLength(2);
    expect(inspected.attempts).toEqual([
      expect.objectContaining({ stepKey: "generate-summary", attemptNo: 1, status: "SUCCEEDED" }),
      expect.objectContaining({ stepKey: "finalize", attemptNo: 1, status: "SUCCEEDED" }),
    ]);
  });

  it("executes the fixed cloud-comparison workflow and publishes only its approved report", async () => {
    const manifest = await request<{
      version: string;
      corpusHash: string;
      purpose: string;
      sources: Array<{
        id: string;
        corpusVersion: string;
        vendor: "AWS" | "AZURE" | "GCP";
        category: "PRICING" | "MANAGED_KUBERNETES";
        title: string;
        publisher: string;
        sourceUrl: string;
        retrievedAt: string;
        excerpt: string;
        contentHash: string;
      }>;
    }>("/reference-corpora/cloud-comparison-v1");
    expect(manifest.sources).toHaveLength(6);
    expect(manifest.corpusHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.purpose).toContain("not current purchasing guidance");
    for (const source of manifest.sources) {
      const { contentHash: _contentHash, ...snapshot } = source;
      expect(source.contentHash).toBe(fixedSourceContentHash(snapshot));
    }
    expect(new Set(manifest.sources.map((source) => source.vendor))).toEqual(
      new Set(["AWS", "AZURE", "GCP"]),
    );

    const reference = await request<{
      workflowVersionId: string;
      workflowName: string;
      created: boolean;
      mode: string;
      provider: string;
      definition: { steps: Array<{ key: string }> };
    }>("/reference-workflows/cloud-comparison", {
      method: "POST",
      body: JSON.stringify({ mode: "scripted", reviewerRole: "research-reviewer" }),
    });
    expect(reference).toMatchObject({
      workflowName: "cloud-comparison-scripted",
      created: true,
      mode: "scripted",
      provider: "scripted-research",
    });
    expect(reference.definition.steps.map((step) => step.key)).toEqual([
      "search-aws",
      "search-azure",
      "search-gcp",
      "collect-sources",
      "analyze-pricing",
      "analyze-features",
      "generate-report",
      "approve-publication",
      "publish-report",
    ]);
    const replayedSetup = await request<{ created: boolean; workflowVersionId: string }>(
      "/reference-workflows/cloud-comparison",
      { method: "POST", body: JSON.stringify({ mode: "scripted", reviewerRole: "research-reviewer" }) },
    );
    expect(replayedSetup).toEqual(expect.objectContaining({
      created: false,
      workflowVersionId: reference.workflowVersionId,
    }));

    const publicationTarget = "controlled://publications/cloud-comparison-demo";
    const run = await request<{ id: string }>("/runs", {
      method: "POST",
      body: JSON.stringify({
        workflowVersionId: reference.workflowVersionId,
        creationKey: "reference-cloud-comparison-run",
        deadlineMs: 60_000,
        input: {
          publicationTarget,
          assumptions: {
            scope: "Managed Kubernetes with supporting general-purpose compute",
            geography: "Representative US region",
            pricing: "No direct cross-vendor SKU equivalence",
          },
        },
      }),
    });
    await waitForPublicStatus(run.id, "WAITING_APPROVAL");

    const sources = await request<{
      sources: Array<{
        id: string;
        ordinal: number;
        corpusVersion: string;
        contentHash: string;
        evidenceHash: string;
      }>;
    }>(`/runs/${run.id}/sources`);
    expect(sources.sources).toHaveLength(6);
    expect(sources.sources.map((source) => source.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(sources.sources.every((source) =>
      source.corpusVersion === manifest.version && source.contentHash === source.evidenceHash
    )).toBe(true);
    await expect(
      database.query(
        "UPDATE research_sources SET excerpt = 'mutated' WHERE id = $1",
        [sources.sources[0]!.id],
      ),
    ).rejects.toMatchObject({ constraint: "research_source_immutable" });

    const usage = await request<{
      usage: Array<{ provider: string; provenance: string; inputTokens: number; outputTokens: number }>;
    }>(`/runs/${run.id}/usage`);
    expect(usage.usage).toHaveLength(2);
    expect(usage.usage.every((entry) =>
      entry.provider === "scripted-research" && entry.provenance === "estimated" &&
      entry.inputTokens > 0 && entry.outputTokens > 0
    )).toBe(true);

    const approvals = await request<{
      approvals: Array<{
        id: string;
        status: string;
        proposalHash: string;
        payloadHash: string;
        payload: {
          report: { content: string; sha256: string; citations: string[] };
          publication: { target: string };
          sourceSet: { corpusHash: string; sourceCount: number };
          approvalBinding: {
            reportHash: string;
            publicationTarget: string;
            corpusHash: string;
            bindingHash: string;
          };
        };
      }>;
    }>(`/runs/${run.id}/approvals`);
    const approval = approvals.approvals[0]!;
    expect(approval.status).toBe("PENDING");
    const reportHash = createHash("sha256")
      .update(approval.payload.report.content, "utf8")
      .digest("hex");
    expect(approval.payload).toMatchObject({
      report: { sha256: reportHash },
      publication: { target: publicationTarget },
      sourceSet: { corpusHash: manifest.corpusHash, sourceCount: 6 },
      approvalBinding: {
        reportHash,
        publicationTarget,
        corpusHash: manifest.corpusHash,
      },
    });
    expect(approval.payload.report.citations.sort()).toEqual(
      manifest.sources.map((source) => source.id).sort(),
    );

    await request(`/approvals/${approval.id}/decisions`, {
      method: "POST",
      headers: {
        "x-agentflow-reviewer-id": "reference-reviewer-1",
        "x-agentflow-reviewer-role": "research-reviewer",
      },
      body: JSON.stringify({
        decisionRequestId: randomUUID(),
        decision: "APPROVE",
        proposalHash: approval.proposalHash,
        payloadHash: approval.payloadHash,
      }),
    });
    await waitForSucceeded(run.id);

    const completed = await request<{
      lifecycle: string;
      steps: Array<{ nodeKey: string; status: string }>;
    }>(`/runs/${run.id}`);
    expect(completed.lifecycle).toBe("SUCCEEDED");
    expect(completed.steps).toHaveLength(9);
    expect(completed.steps.every((step) => step.status === "SUCCEEDED")).toBe(true);
    const executions = await request<{
      executions: Array<{ toolName: string; invocationStatus: string; idempotencyStatus: string }>;
    }>(`/runs/${run.id}/tool-executions`);
    expect(executions.executions).toEqual([
      expect.objectContaining({
        toolName: "publish-approved-report",
        invocationStatus: "SUCCEEDED",
        idempotencyStatus: "SUCCEEDED",
      }),
    ]);
    const effects = await database.query<{ count: string }>(
      `SELECT count(*) AS count FROM controlled_publication_effects cpe
       JOIN idempotency_records ir ON ir.request_hash = cpe.request_hash
       WHERE ir.run_id = $1`,
      [run.id],
    );
    expect(effects.rows[0]?.count).toBe("1");
  }, 30_000);

  it("runs a bounded agent node with separate durable LLM and tool operations", async () => {
    await worker.pause(true);
    try {
      const workflow = await request<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ name: "bounded-agent-workflow", description: "Bounded agent" }),
      });
      const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          definition: {
            steps: [{
              key: "analyze",
              kind: "AGENT",
              handler: "agent",
              provider: "fake",
              model: "fake-model",
              instructions: "Return a concise final answer.",
              allowedTools: ["lookup"],
              maxTurns: 3,
            }],
          },
        }),
      });
      const created = await request<{
        id: string;
        steps: Array<{ id: string; dispatchGeneration: number }>;
      }>("/runs", {
        method: "POST",
        body: JSON.stringify({
          workflowVersionId: version.id,
          input: { topic: "bounded recovery" },
          creationKey: "integration-bounded-agent",
        }),
      });
      const toolDecision: LLMResponse = {
        text: "",
        toolCalls: [{ id: "lookup-1", name: "lookup", arguments: { key: "fact" } }],
        finishReason: "tool_calls",
        usage: {
          provenance: "reported",
          inputTokens: 5,
          outputTokens: 2,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          raw: { input_tokens: 5, output_tokens: 2 },
        },
        providerRequestId: "fake-agent-request-1",
        resolvedModel: "fake-model-v1",
        opaqueState: { namespace: "agentflow.fake", version: 1, cursor: "tool" },
      };
      const response: LLMResponse = {
        text: "Agent result",
        toolCalls: [],
        finishReason: "stop",
        usage: {
          provenance: "reported",
          inputTokens: 9,
          outputTokens: 3,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          raw: { input_tokens: 9, output_tokens: 3 },
        },
        providerRequestId: "fake-agent-request-2",
        resolvedModel: "fake-model-v1",
        opaqueState: { namespace: "agentflow.fake", version: 1, cursor: "done" },
      };
      const fake = new DeterministicFakeProvider([toolDecision, response]);
      const tools = new ToolRegistry().register({
        name: "lookup",
        version: "1",
        description: "Return a deterministic saved fact",
        effectClass: "REPEATABLE_READ",
        providerSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
        inputSchema: z.object({ key: z.literal("fact") }).strict(),
        outputSchema: z.object({ value: z.string() }),
        execute: () => ({ value: "durable" }),
      });
      const harness = new AgentHarness(new ProviderRegistry().register(fake), tools);
      const step = created.steps[0]!;
      const result = await processOperationJob(
        database,
        "bounded-agent-worker",
        15_000,
        { data: {
          runId: created.id,
          operationId: step.id,
          workflowVersionId: version.id,
          dispatchGeneration: step.dispatchGeneration,
        } } as Job,
        5_000,
        60_000,
        harness,
      );
      expect(result).toMatchObject({ skipped: false, runCompleted: true });
      expect(fake.calls).toHaveLength(2);
      const completed = await request<{
        lifecycle: string;
        steps: Array<{ acceptedOutput: Record<string, unknown> }>;
      }>(`/runs/${created.id}`);
      expect(completed.lifecycle).toBe("SUCCEEDED");
      expect(completed.steps[0]?.acceptedOutput).toMatchObject({
        content: "Agent result",
        provider: "fake",
        turns: 2,
      });
      const operations = await request<{ operations: Array<{ kind: string; ordinal: number; status: string }> }>(
        `/runs/${created.id}/harness-operations`,
      );
      expect(operations.operations.map(({ kind, ordinal, status }) => ({ kind, ordinal, status }))).toEqual([
        { kind: "LLM", ordinal: 0, status: "SUCCEEDED" },
        { kind: "TOOL", ordinal: 1, status: "SUCCEEDED" },
        { kind: "LLM", ordinal: 2, status: "SUCCEEDED" },
      ]);
      const usage = await request<{ usage: Array<{ inputTokens: number; outputTokens: number }> }>(
        `/runs/${created.id}/usage`,
      );
      expect(usage.usage).toEqual([
        expect.objectContaining({ inputTokens: 5, outputTokens: 2 }),
        expect.objectContaining({ inputTokens: 9, outputTokens: 3 }),
      ]);
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("persists provider usage and opaque continuation state per logical operation", async () => {
    await worker.pause(true);
    try {
      const workflow = await request<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ name: "harness-ledger-workflow", description: "Provider ledger" }),
      });
      const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          definition: {
            steps: [{
              key: "ledger-agent",
              kind: "AGENT",
              handler: "agent",
              provider: "fake",
              model: "fake-model",
              instructions: "Test provider persistence.",
              allowedTools: [],
              maxTurns: 3,
            }],
          },
        }),
      });
      const created = await request<{
        id: string;
        steps: Array<{ id: string; dispatchGeneration: number }>;
      }>("/runs", {
        method: "POST",
        body: JSON.stringify({
          workflowVersionId: version.id,
          input: { topic: "provider persistence" },
          creationKey: "integration-harness-ledger",
        }),
      });
      const step = created.steps[0]!;
      const claimed = await claimOperation(database, {
        runId: created.id,
        operationId: step.id,
        workflowVersionId: version.id,
        dispatchGeneration: step.dispatchGeneration,
      }, "harness-ledger-worker", 15_000);
      expect(claimed).not.toBeNull();

      const begun = await beginHarnessLlmOperation(database, claimed!, {
        ordinal: 0,
        turn: 1,
        maxTurns: 3,
        provider: "fake",
        adapterVersion: "1.0.0",
        model: "fake-model",
        request: { messages: [{ role: "user", content: "summarize" }] },
      });
      expect(begun.replayed).toBe(false);
      if (begun.replayed) throw new Error("Expected a new provider call");
      const output = { text: "persisted response", toolCalls: [], finishReason: "stop" };
      const continuationState = { namespace: "agentflow.fake", version: 1, cursor: "opaque-1" };
      await completeHarnessLlmOperation(database, claimed!, begun.providerCallId, {
        output,
        continuationState,
        providerRequestId: "fake-request-1",
        resolvedModel: "fake-model-v1",
        finishReason: "stop",
        usage: {
          provenance: "reported",
          inputTokens: 11,
          outputTokens: 7,
          cachedInputTokens: 2,
          reasoningTokens: 1,
          raw: { input_tokens: 11, output_tokens: 7 },
        },
      });

      const replay = await beginHarnessLlmOperation(database, claimed!, {
        ordinal: 0,
        turn: 1,
        maxTurns: 3,
        provider: "fake",
        adapterVersion: "1.0.0",
        model: "fake-model",
        request: { messages: [{ role: "user", content: "summarize" }] },
      });
      expect(replay).toMatchObject({ replayed: true, output, continuationState });

      const ledger = await request<{
        operations: Array<{
          status: string;
          turn: number;
          maxTurns: number;
          continuationState: Record<string, unknown>;
          calls: Array<{ status: string; providerRequestId: string }>;
        }>;
      }>(`/runs/${created.id}/harness-operations`);
      expect(ledger.operations[0]).toMatchObject({
        status: "SUCCEEDED",
        turn: 1,
        maxTurns: 3,
        continuationState,
        calls: [{ status: "SUCCEEDED", providerRequestId: "fake-request-1" }],
      });
      const usage = await request<{
        usage: Array<{ provider: string; model: string; inputTokens: number; outputTokens: number }>;
      }>(`/runs/${created.id}/usage`);
      expect(usage.usage).toEqual([
        expect.objectContaining({
          provider: "fake",
          model: "fake-model-v1",
          inputTokens: 11,
          outputTokens: 7,
        }),
      ]);

      await completeOperation(database, claimed!, output);
    } finally {
      await worker.resume();
    }
  }, 20_000);

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
      expect(repaired).toMatchObject({ expiredLeases: 1, recoveredDispatches: 0 });
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
        status: "RETRY_WAIT",
        dispatch_generation: 1,
        abandoned_attempts: "1",
      });

      await database.query(
        "UPDATE workflow_steps SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
        [step.id],
      );
      expect(await repairScheduling(database, 10_000)).toMatchObject({ dueRetries: 1 });

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
      expect(repaired).toMatchObject({ expiredLeases: 0, recoveredDispatches: 1 });
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
      expect(secondRepair).toMatchObject({ expiredLeases: 0, recoveredDispatches: 0 });

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
      expect(missingRepair).toMatchObject({ expiredLeases: 0, recoveredDispatches: 1 });
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

  it("settles a permanent worker execution failure in the application ledger", async () => {
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

      const failureResult = await processOperationJob(database, "failing-worker", 1_000, job, 250);
      expect(failureResult).toMatchObject({
        failed: true,
        failure: { errorClass: "PERMANENT", retryable: false },
        settlement: { retryScheduled: false, runFailed: true },
      });
      const failedDelivery = await database.query<{ status: string; attempts: string; lifecycle: string }>(
        `SELECT ws.status, wr.lifecycle,
           (SELECT count(*) FROM step_attempts sa
            WHERE sa.step_id = ws.id AND sa.status = 'FAILED') AS attempts
         FROM workflow_steps ws JOIN workflow_runs wr ON wr.id = ws.run_id
         WHERE ws.id = $1`,
        [step.id],
      );
      expect(failedDelivery.rows[0]).toEqual({ status: "FAILED", attempts: "1", lifecycle: "FAILED" });
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("persists bounded retry policy, sampled backoff, and terminal exhaustion", async () => {
    await worker.pause(true);
    try {
      const workflow = await request<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ name: "retry-policy-workflow", description: "Retry policy" }),
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
          input: { topic: "retry policy" },
          creationKey: "integration-retry-policy",
          deadlineMs: 60_000,
          retryPolicy: {
            maxAttempts: 2,
            initialBackoffMs: 1_000,
            multiplier: 2,
            maxBackoffMs: 1_000,
          },
        }),
      });
      const step = created.steps[0]!;
      const conflictingCreation = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowVersionId: version.id,
          input: { topic: "retry policy" },
          creationKey: "integration-retry-policy",
          deadlineMs: 60_000,
          retryPolicy: {
            maxAttempts: 3,
            initialBackoffMs: 1_000,
            multiplier: 2,
            maxBackoffMs: 1_000,
          },
        }),
      });
      expect(conflictingCreation.status).toBe(409);
      const job = {
        runId: created.id,
        operationId: step.id,
        workflowVersionId: version.id,
        dispatchGeneration: step.dispatchGeneration,
      };
      const first = await claimOperation(database, job, "retry-worker-1", 15_000, 30_000);
      expect(first).not.toBeNull();
      const firstSettlement = await settleOperationFailure(database, first!, {
        code: "UPSTREAM_UNAVAILABLE",
        errorClass: "TRANSIENT",
        message: "temporary upstream failure",
        retryable: true,
        retryAfterMs: 500,
      });
      expect(firstSettlement).toMatchObject({ retryScheduled: true });

      const waiting = await database.query<{
        status: string;
        wait_reason: string;
        delay_ms: number;
        error_class: string;
        retryable: boolean;
      }>(
        `SELECT ws.status, wr.wait_reason,
           EXTRACT(EPOCH FROM (ws.next_attempt_at - sa.finished_at)) * 1000 AS delay_ms,
           sa.error_class, sa.retryable
         FROM workflow_steps ws
         JOIN workflow_runs wr ON wr.id = ws.run_id
         JOIN step_attempts sa ON sa.step_id = ws.id AND sa.attempt_no = 1
         WHERE ws.id = $1`,
        [step.id],
      );
      expect(waiting.rows[0]).toMatchObject({
        status: "RETRY_WAIT",
        wait_reason: "RETRY",
        error_class: "TRANSIENT",
        retryable: true,
      });
      expect(Number(waiting.rows[0]?.delay_ms)).toBeGreaterThanOrEqual(500);
      expect(Number(waiting.rows[0]?.delay_ms)).toBeLessThanOrEqual(1_000);

      const persistedDue = firstSettlement.retryScheduled ? firstSettlement.nextAttemptAt : null;
      expect(await repairScheduling(database, 10_000)).toMatchObject({ dueRetries: 0 });
      const unchanged = await database.query<{ next_attempt_at: Date }>(
        "SELECT next_attempt_at FROM workflow_steps WHERE id = $1",
        [step.id],
      );
      expect(unchanged.rows[0]?.next_attempt_at.getTime()).toBe(persistedDue?.getTime());

      await database.query(
        "UPDATE workflow_steps SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
        [step.id],
      );
      expect(await repairScheduling(database, 10_000)).toMatchObject({ dueRetries: 1 });
      const second = await claimOperation(
        database,
        { ...job, dispatchGeneration: 2 },
        "retry-worker-2",
        15_000,
        30_000,
      );
      expect(second?.attemptNo).toBe(2);
      const exhausted = await settleOperationFailure(database, second!, {
        code: "UPSTREAM_UNAVAILABLE",
        errorClass: "TRANSIENT",
        message: "still unavailable",
        retryable: true,
      });
      expect(exhausted).toEqual({ retryScheduled: false, runFailed: true });
      const terminal = await request<{
        lifecycle: string;
        waitReason: string;
        failure: { exhausted: boolean };
      }>(`/runs/${created.id}`);
      expect(terminal).toMatchObject({
        lifecycle: "FAILED",
        waitReason: "NONE",
        failure: { exhausted: true },
      });
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("honors pause and resume across an active-operation boundary", async () => {
    await worker.pause(true);
    try {
      const workflow = await request<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ name: "pause-resume-workflow", description: "Control state" }),
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
          input: { topic: "pause resume" },
          creationKey: "integration-pause-resume",
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
        "pause-worker",
        15_000,
      );
      expect(claim).not.toBeNull();

      const pauseRequested = await request<{ control: string; publicStatus: string }>(
        `/runs/${created.id}/pause`,
        { method: "POST", body: "{}" },
      );
      expect(pauseRequested).toMatchObject({ control: "PAUSE_REQUESTED", publicStatus: "PAUSE_REQUESTED" });
      await completeOperation(database, claim!, executeDeterministicOperation(claim!));

      const paused = await request<{
        control: string;
        steps: Array<{ id: string; status: string }>;
      }>(`/runs/${created.id}`);
      expect(paused.control).toBe("PAUSED");
      expect(paused.steps.map((candidate) => candidate.status)).toEqual(["SUCCEEDED", "READY"]);
      const successor = paused.steps[1]!;
      const pausedOutbox = await database.query<{ count: string }>(
        "SELECT count(*) FROM outbox WHERE step_id = $1",
        [successor.id],
      );
      expect(pausedOutbox.rows[0]?.count).toBe("0");

      const resumed = await request<{ control: string; publicStatus: string }>(
        `/runs/${created.id}/resume`,
        { method: "POST", body: "{}" },
      );
      expect(resumed.control).toBe("RUN");
      const resumedOutbox = await database.query<{ generations: number[] }>(
        "SELECT ARRAY_AGG(generation ORDER BY generation) AS generations FROM outbox WHERE step_id = $1",
        [successor.id],
      );
      expect(resumedOutbox.rows[0]?.generations).toEqual([2]);
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("fences an attempt deadline and persists a retry wait", async () => {
    await worker.pause(true);
    try {
      const workflow = await request<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ name: "attempt-timeout-workflow", description: "Attempt timeout" }),
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
          input: { topic: "attempt timeout" },
          creationKey: "integration-attempt-timeout",
          retryPolicy: {
            maxAttempts: 2,
            initialBackoffMs: 1_000,
            multiplier: 2,
            maxBackoffMs: 2_000,
          },
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
        "timeout-worker",
        15_000,
        1_000,
      );
      expect(claim).not.toBeNull();
      await database.query(
        "UPDATE step_attempts SET deadline_at = now() - interval '1 second' WHERE id = $1",
        [claim!.attemptId],
      );

      expect(await repairScheduling(database, 10_000)).toMatchObject({
        timedOutAttempts: 1,
        expiredLeases: 0,
      });
      const timedOut = await database.query<{
        step_status: string;
        attempt_status: string;
        error_class: string;
        code: string;
      }>(
        `SELECT ws.status AS step_status, sa.status AS attempt_status,
           sa.error_class, sa.error_json->>'code' AS code
         FROM workflow_steps ws JOIN step_attempts sa ON sa.step_id = ws.id
         WHERE ws.id = $1`,
        [step.id],
      );
      expect(timedOut.rows[0]).toEqual({
        step_status: "RETRY_WAIT",
        attempt_status: "FAILED",
        error_class: "TIMEOUT",
        code: "ATTEMPT_TIMEOUT",
      });
      await expect(
        completeOperation(database, claim!, executeDeterministicOperation(claim!)),
      ).rejects.toThrow("lease fencing");
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("serializes resume with a due retry without duplicate dispatch", async () => {
    await worker.pause(true);
    try {
      const workflow = await request<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ name: "resume-retry-race-workflow", description: "Resume race" }),
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
          input: { topic: "resume retry race" },
          creationKey: "integration-resume-retry-race",
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
        "resume-race-worker",
        15_000,
      );
      expect(claim).not.toBeNull();
      await controlRun(database, created.id, "pause");
      expect(await settleOperationFailure(database, claim!, {
        code: "TEMPORARY_FAILURE",
        errorClass: "TRANSIENT",
        message: "retry after resume",
        retryable: true,
      })).toMatchObject({ retryScheduled: true });
      await database.query(
        "UPDATE workflow_steps SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
        [step.id],
      );

      await Promise.all([
        controlRun(database, created.id, "resume"),
        repairScheduling(database, 10_000),
      ]);
      await repairScheduling(database, 10_000);
      const persisted = await database.query<{
        status: string;
        control: string;
        dispatch_generation: number;
        replacement_dispatches: string;
        retry_due_events: string;
      }>(
        `SELECT ws.status, wr.control, ws.dispatch_generation,
           (SELECT count(*) FROM outbox WHERE step_id = ws.id AND generation = 2) AS replacement_dispatches,
           (SELECT count(*) FROM audit_events
            WHERE step_id = ws.id AND type = 'RETRY_DUE') AS retry_due_events
         FROM workflow_steps ws JOIN workflow_runs wr ON wr.id = ws.run_id
         WHERE ws.id = $1`,
        [step.id],
      );
      expect(persisted.rows[0]).toEqual({
        status: "READY",
        control: "RUN",
        dispatch_generation: 2,
        replacement_dispatches: "1",
        retry_due_events: "1",
      });
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("serializes cancellation and timeout against worker completion", async () => {
    await worker.pause(true);
    try {
      const workflow = await request<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ name: "control-race-workflow", description: "Control races" }),
      });
      const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
        method: "POST",
        body: JSON.stringify({ version: 1, definition: defaultWorkflowDefinition }),
      });

      for (const mode of ["cancel", "timeout"] as const) {
        const created = await request<{
          id: string;
          steps: Array<{ id: string; dispatchGeneration: number }>;
        }>("/runs", {
          method: "POST",
          body: JSON.stringify({
            workflowVersionId: version.id,
            input: { mode },
            creationKey: `integration-${mode}-race`,
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
          `${mode}-worker`,
          15_000,
        );
        expect(claim).not.toBeNull();

        if (mode === "cancel") {
          await Promise.all([
            controlRun(database, created.id, "cancel"),
            completeOperation(database, claim!, executeDeterministicOperation(claim!)),
          ]);
        } else {
          await database.query(
            "UPDATE workflow_runs SET deadline_at = now() - interval '1 second' WHERE id = $1",
            [created.id],
          );
          await Promise.allSettled([
            repairScheduling(database, 10_000),
            completeOperation(database, claim!, executeDeterministicOperation(claim!)),
          ]);
        }

        const run = await request<{
          lifecycle: string;
          steps: Array<{ status: string }>;
        }>(`/runs/${created.id}`);
        expect(run.lifecycle).toBe(mode === "cancel" ? "CANCELLED" : "TIMED_OUT");
        expect(run.steps.some((candidate) => candidate.status === "READY" || candidate.status === "RUNNING")).toBe(false);
      }
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
        dispatch_generation: 1,
        replacement_dispatches: "0",
        abandoned_attempts: "1",
        expiry_events: "1",
      });

      await database.query(
        "UPDATE workflow_steps SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
        [step.id],
      );
      const dueRepairs = await Promise.all([
        repairScheduling(database, 10_000),
        repairScheduling(database, 10_000),
      ]);
      expect(dueRepairs.reduce((sum, result) => sum + result.dueRetries, 0)).toBe(1);
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("persists an approval across API restart and replays an exact decision once", async () => {
    await worker.pause(true);
    try {
      const { run, approval } = await createApprovalRun("approval-restart-workflow");
      expect(run.publicStatus).toBe("WAITING_APPROVAL");
      expect(run.steps[0]?.status).toBe("WAITING_APPROVAL");
      expect(approval).toMatchObject({ status: "PENDING", reviewerRole: "release-manager" });

      await restartApi();
      const decisionRequestId = randomUUID();
      const decision = {
        decisionRequestId,
        decision: "APPROVE",
        proposalHash: approval.proposalHash,
        payloadHash: approval.payloadHash,
      };
      const init = {
        method: "POST",
        headers: {
          "x-agentflow-reviewer-id": "reviewer-1",
          "x-agentflow-reviewer-role": "release-manager",
        },
        body: JSON.stringify(decision),
      } satisfies RequestInit;
      const accepted = await request<{ replayed: boolean; run: { waitReason: string } }>(
        `/approvals/${approval.id}/decisions`,
        init,
      );
      expect(accepted).toMatchObject({ replayed: false, run: { waitReason: "NONE" } });
      const replayed = await request<{ replayed: boolean }>(
        `/approvals/${approval.id}/decisions`,
        init,
      );
      expect(replayed.replayed).toBe(true);

      const persisted = await database.query<{ successors: string; dispatches: string }>(
        `SELECT
           (SELECT count(*) FROM workflow_steps WHERE run_id = $1 AND position = 1) AS successors,
           (SELECT count(*) FROM outbox WHERE run_id = $1 AND generation = 1) AS dispatches`,
        [run.id],
      );
      expect(persisted.rows[0]).toEqual({ successors: "1", dispatches: "1" });
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("rejects role and hash mismatches without changing the pending approval", async () => {
    const { run, approval } = await createApprovalRun("approval-mismatch-workflow");
    const baseDecision = {
      decisionRequestId: randomUUID(),
      decision: "APPROVE",
      proposalHash: approval.proposalHash,
      payloadHash: approval.payloadHash,
    };
    const wrongRole = await rawRequest(`/approvals/${approval.id}/decisions`, {
      method: "POST",
      headers: {
        "x-agentflow-reviewer-id": "reviewer-2",
        "x-agentflow-reviewer-role": "developer",
      },
      body: JSON.stringify(baseDecision),
    });
    expect(wrongRole.status).toBe(409);
    const wrongHash = await rawRequest(`/approvals/${approval.id}/decisions`, {
      method: "POST",
      headers: {
        "x-agentflow-reviewer-id": "reviewer-2",
        "x-agentflow-reviewer-role": "release-manager",
      },
      body: JSON.stringify({ ...baseDecision, decisionRequestId: randomUUID(), payloadHash: "0".repeat(64) }),
    });
    expect(wrongHash.status).toBe(409);
    await expect(
      database.query(
        "UPDATE approvals SET payload_hash = $1 WHERE id = $2",
        ["f".repeat(64), approval.id],
      ),
    ).rejects.toMatchObject({ constraint: "approvals_identity_immutable" });
    const pending = await request<{ approvals: Array<{ status: string }> }>(
      `/runs/${run.id}/approvals`,
    );
    expect(pending.approvals[0]?.status).toBe("PENDING");
  });

  it("fences late decisions after cancellation and approval expiration", async () => {
    const cancelled = await createApprovalRun("approval-cancel-workflow");
    await request(`/runs/${cancelled.run.id}/cancel`, { method: "POST" });
    const lateCancelled = await rawRequest(`/approvals/${cancelled.approval.id}/decisions`, {
      method: "POST",
      headers: {
        "x-agentflow-reviewer-id": "reviewer-3",
        "x-agentflow-reviewer-role": "release-manager",
      },
      body: JSON.stringify({
        decisionRequestId: randomUUID(),
        decision: "APPROVE",
        proposalHash: cancelled.approval.proposalHash,
        payloadHash: cancelled.approval.payloadHash,
      }),
    });
    expect(lateCancelled.status).toBe(409);

    const expired = await createApprovalRun("approval-expiry-workflow", 1_000);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const repairs = await Promise.all([
      repairScheduling(database, 10_000),
      repairScheduling(database, 10_000),
    ]);
    expect(repairs.reduce((sum, result) => sum + result.expiredApprovals, 0)).toBe(1);
    const lateExpired = await rawRequest(`/approvals/${expired.approval.id}/decisions`, {
      method: "POST",
      headers: {
        "x-agentflow-reviewer-id": "reviewer-3",
        "x-agentflow-reviewer-role": "release-manager",
      },
      body: JSON.stringify({
        decisionRequestId: randomUUID(),
        decision: "APPROVE",
        proposalHash: expired.approval.proposalHash,
        payloadHash: expired.approval.payloadHash,
      }),
    });
    expect(lateExpired.status).toBe(409);
    const settled = await request<{
      lifecycle: string;
      failure: { code: string };
    }>(`/runs/${expired.run.id}`);
    expect(settled).toMatchObject({ lifecycle: "FAILED", failure: { code: "APPROVAL_EXPIRED" } });

    const timedOut = await createApprovalRun("approval-run-deadline-workflow");
    await database.query(
      "UPDATE workflow_runs SET deadline_at = now() - interval '1 second' WHERE id = $1",
      [timedOut.run.id],
    );
    const afterRunDeadline = await rawRequest(`/approvals/${timedOut.approval.id}/decisions`, {
      method: "POST",
      headers: {
        "x-agentflow-reviewer-id": "reviewer-3",
        "x-agentflow-reviewer-role": "release-manager",
      },
      body: JSON.stringify({
        decisionRequestId: randomUUID(),
        decision: "APPROVE",
        proposalHash: timedOut.approval.proposalHash,
        payloadHash: timedOut.approval.payloadHash,
      }),
    });
    expect(afterRunDeadline.status).toBe(409);
    const deadlineRun = await request<{ lifecycle: string; failure: { code: string } }>(
      `/runs/${timedOut.run.id}`,
    );
    expect(deadlineRun).toMatchObject({
      lifecycle: "TIMED_OUT",
      failure: { code: "RUN_DEADLINE_EXCEEDED" },
    });
  });

  it("serializes concurrent double approval into one continuation dispatch", async () => {
    await worker.pause(true);
    try {
      const { run, approval } = await createApprovalRun("approval-double-workflow");
      const decide = (decisionRequestId: string) => rawRequest(`/approvals/${approval.id}/decisions`, {
        method: "POST",
        headers: {
          "x-agentflow-reviewer-id": "reviewer-4",
          "x-agentflow-reviewer-role": "release-manager",
        },
        body: JSON.stringify({
          decisionRequestId,
          decision: "APPROVE",
          proposalHash: approval.proposalHash,
          payloadHash: approval.payloadHash,
        }),
      });
      const responses = await Promise.all([decide(randomUUID()), decide(randomUUID())]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const persisted = await database.query<{ approvals: string; successors: string; dispatches: string }>(
        `SELECT
           (SELECT count(*) FROM approvals WHERE id = $2 AND status = 'APPROVED') AS approvals,
           (SELECT count(*) FROM workflow_steps WHERE run_id = $1 AND position = 1) AS successors,
           (SELECT count(*) FROM outbox WHERE run_id = $1) AS dispatches`,
        [run.id, approval.id],
      );
      expect(persisted.rows[0]).toEqual({ approvals: "1", successors: "1", dispatches: "1" });
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("records approval while paused without dispatching or implicitly resuming", async () => {
    await worker.pause(true);
    try {
      const { run, approval } = await createApprovalRun("approval-paused-workflow");
      await request(`/runs/${run.id}/pause`, { method: "POST" });
      const decided = await request<{
        run: { control: string; steps: Array<{ status: string }> };
      }>(`/approvals/${approval.id}/decisions`, {
        method: "POST",
        headers: {
          "x-agentflow-reviewer-id": "reviewer-5",
          "x-agentflow-reviewer-role": "release-manager",
        },
        body: JSON.stringify({
          decisionRequestId: randomUUID(),
          decision: "APPROVE",
          proposalHash: approval.proposalHash,
          payloadHash: approval.payloadHash,
        }),
      });
      expect(decided.run.control).toBe("PAUSED");
      expect(decided.run.steps[1]?.status).toBe("READY");
      const beforeResume = await database.query<{ dispatches: string }>(
        "SELECT count(*) AS dispatches FROM outbox WHERE run_id = $1",
        [run.id],
      );
      expect(beforeResume.rows[0]?.dispatches).toBe("0");
      await request(`/runs/${run.id}/resume`, { method: "POST" });
      const afterResume = await database.query<{ dispatches: string }>(
        "SELECT count(*) AS dispatches FROM outbox WHERE run_id = $1",
        [run.id],
      );
      expect(afterResume.rows[0]?.dispatches).toBe("1");
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("durably rejects an approval without creating a continuation", async () => {
    const { run, approval } = await createApprovalRun("approval-rejection-workflow");
    const rejected = await request<{
      run: { lifecycle: string; failure: { code: string } };
      approvals: Array<{ status: string; decidedBy: string; decidedRole: string }>;
    }>(`/approvals/${approval.id}/decisions`, {
      method: "POST",
      headers: {
        "x-agentflow-reviewer-id": "reviewer-6",
        "x-agentflow-reviewer-role": "release-manager",
      },
      body: JSON.stringify({
        decisionRequestId: randomUUID(),
        decision: "REJECT",
        proposalHash: approval.proposalHash,
        payloadHash: approval.payloadHash,
      }),
    });
    expect(rejected.run).toMatchObject({
      lifecycle: "FAILED",
      failure: { code: "APPROVAL_REJECTED" },
    });
    expect(rejected.approvals[0]).toMatchObject({
      status: "REJECTED",
      decidedBy: "reviewer-6",
      decidedRole: "release-manager",
    });
    const successors = await database.query<{ count: string }>(
      "SELECT count(*) AS count FROM workflow_steps WHERE run_id = $1 AND position > 0",
      [run.id],
    );
    expect(successors.rows[0]?.count).toBe("0");
  });

  it("executes a classified publication through the worker and independent receiver ledger", async () => {
    const { run } = await createPublicationRun(
      "worker-publication-workflow",
      "RECEIVER_IDEMPOTENT_WRITE",
    );
    await waitForSucceeded(run.id);
    const persisted = await database.query<{
      effects: string;
      records: string;
      executions: string;
      record_status: string;
    }>(
      `SELECT
         (SELECT count(*) FROM controlled_publication_effects cpe
          JOIN idempotency_records ir ON ir.request_hash = cpe.request_hash
          WHERE ir.run_id = $1) AS effects,
         (SELECT count(*) FROM idempotency_records WHERE run_id = $1) AS records,
         (SELECT count(*) FROM tool_executions WHERE run_id = $1) AS executions,
         (SELECT status FROM idempotency_records WHERE run_id = $1) AS record_status`,
      [run.id],
    );
    expect(persisted.rows[0]).toEqual({
      effects: "1",
      records: "1",
      executions: "1",
      record_status: "SUCCEEDED",
    });
  }, 20_000);

  it("reuses a stable receiver key after remote success and a local crash", async () => {
    await worker.pause(true);
    try {
      const { version, run } = await createPublicationRun(
        "idempotent-publication-workflow",
        "RECEIVER_IDEMPOTENT_WRITE",
      );
      const step = run.steps[0]!;
      expect(step.effectClass).toBe("RECEIVER_IDEMPOTENT_WRITE");
      const firstClaim = await claimOperation(
        database,
        {
          runId: run.id,
          operationId: step.id,
          workflowVersionId: version.id,
          dispatchGeneration: step.dispatchGeneration,
        },
        "publication-worker-1",
        15_000,
      );
      expect(firstClaim).not.toBeNull();
      const firstIntent = await prepareToolExecution(database, firstClaim!);
      const remoteResult = await publishToControlledReceiver(database, firstIntent, firstClaim!.input);
      expect(remoteResult.replayed).toBe(false);

      await database.query(
        "UPDATE workflow_steps SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [step.id],
      );
      expect(await repairScheduling(database, 10_000)).toMatchObject({
        expiredLeases: 1,
        unknownEffects: 0,
      });
      await database.query(
        "UPDATE workflow_steps SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
        [step.id],
      );
      expect(await repairScheduling(database, 10_000)).toMatchObject({ dueRetries: 1 });
      const retryState = await request<{
        steps: Array<{ dispatchGeneration: number; status: string }>;
      }>(`/runs/${run.id}`);
      const secondClaim = await claimOperation(
        database,
        {
          runId: run.id,
          operationId: step.id,
          workflowVersionId: version.id,
          dispatchGeneration: retryState.steps[0]!.dispatchGeneration,
        },
        "publication-worker-2",
        15_000,
      );
      expect(secondClaim).not.toBeNull();
      const output = await executeToolOperation(database, secondClaim!);
      expect(output.receiverReplayed).toBe(true);
      await completeOperation(database, secondClaim!, output);

      const completed = await request<{ lifecycle: string }>(`/runs/${run.id}`);
      expect(completed.lifecycle).toBe("SUCCEEDED");
      const persisted = await database.query<{
        receiver_effects: string;
        idempotency_records: string;
        stable_keys: string;
        tool_executions: string;
        abandoned: string;
        succeeded: string;
      }>(
        `SELECT
           (SELECT count(*) FROM controlled_publication_effects
            WHERE request_hash = $2) AS receiver_effects,
           (SELECT count(*) FROM idempotency_records WHERE operation_id = $1) AS idempotency_records,
           (SELECT count(DISTINCT ir.idempotency_key)
            FROM tool_executions te JOIN idempotency_records ir ON ir.id = te.idempotency_record_id
            WHERE te.step_id = $1) AS stable_keys,
           (SELECT count(*) FROM tool_executions WHERE step_id = $1) AS tool_executions,
           (SELECT count(*) FROM tool_executions
            WHERE step_id = $1 AND invocation_status = 'ABANDONED') AS abandoned,
           (SELECT count(*) FROM tool_executions
            WHERE step_id = $1 AND invocation_status = 'SUCCEEDED') AS succeeded`,
        [step.id, firstIntent.requestHash],
      );
      expect(persisted.rows[0]).toEqual({
        receiver_effects: "1",
        idempotency_records: "1",
        stable_keys: "1",
        tool_executions: "2",
        abandoned: "1",
        succeeded: "1",
      });
      await expect(
        database.query(
          "UPDATE idempotency_records SET idempotency_key = $1 WHERE operation_id = $2",
          ["mutated-key", step.id],
        ),
      ).rejects.toMatchObject({ constraint: "idempotency_identity_immutable" });
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("moves an unsupported ambiguous receiver to UNKNOWN without resending", async () => {
    await worker.pause(true);
    try {
      const { version, run } = await createPublicationRun(
        "unsafe-publication-workflow",
        "UNSAFE_WRITE",
      );
      const step = run.steps[0]!;
      const claim = await claimOperation(
        database,
        {
          runId: run.id,
          operationId: step.id,
          workflowVersionId: version.id,
          dispatchGeneration: step.dispatchGeneration,
        },
        "unsafe-publication-worker",
        15_000,
      );
      expect(claim).not.toBeNull();
      const intent = await prepareToolExecution(database, claim!);
      const remoteResult = await publishToControlledReceiver(database, intent, claim!.input);
      expect(remoteResult.replayed).toBe(false);
      await database.query(
        "UPDATE workflow_steps SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [step.id],
      );
      expect(await repairScheduling(database, 10_000)).toMatchObject({
        expiredLeases: 1,
        unknownEffects: 1,
        dueRetries: 0,
      });
      await repairScheduling(database, 0);
      const unknown = await request<{
        lifecycle: string;
        waitReason: string;
        publicStatus: string;
        steps: Array<{ status: string }>;
      }>(`/runs/${run.id}`);
      expect(unknown).toMatchObject({
        lifecycle: "OPEN",
        waitReason: "RECONCILIATION",
        publicStatus: "NEEDS_ATTENTION",
      });
      expect(unknown.steps[0]?.status).toBe("UNKNOWN");
      const beforeResolution = await database.query<{
        receiver_effects: string;
        replacement_dispatches: string;
        idempotency_status: string;
      }>(
        `SELECT
           (SELECT count(*) FROM controlled_publication_effects
            WHERE request_hash = $2) AS receiver_effects,
           (SELECT count(*) FROM outbox WHERE step_id = $1 AND generation > 1) AS replacement_dispatches,
           (SELECT status FROM idempotency_records WHERE operation_id = $1) AS idempotency_status`,
        [step.id, intent.requestHash],
      );
      expect(beforeResolution.rows[0]).toEqual({
        receiver_effects: "1",
        replacement_dispatches: "0",
        idempotency_status: "UNKNOWN",
      });
      const executions = await request<{
        executions: Array<{ id: string; invocationStatus: string }>;
      }>(`/runs/${run.id}/tool-executions`);
      expect(executions.executions[0]?.invocationStatus).toBe("UNKNOWN");
      const reconciled = await request<{ lifecycle: string }>(
        `/tool-executions/${executions.executions[0]!.id}/reconcile`,
        {
          method: "POST",
          body: JSON.stringify({
            resolution: "CONFIRM_SUCCEEDED",
            receiverId: remoteResult.receiverId,
            receipt: remoteResult.receipt,
          }),
        },
      );
      expect(reconciled.lifecycle).toBe("SUCCEEDED");
      const afterResolution = await database.query<{ receiver_effects: string }>(
        "SELECT count(*) AS receiver_effects FROM controlled_publication_effects WHERE request_hash = $1",
        [intent.requestHash],
      );
      expect(afterResolution.rows[0]?.receiver_effects).toBe("1");
    } finally {
      await worker.resume();
    }
  }, 20_000);
});
