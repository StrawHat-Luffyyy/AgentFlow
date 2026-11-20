import type { Credential } from "../../apps/api/src/auth.ts";
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
import { ScriptedResearchProvider, ensureCloudComparisonWorkflow, fixedSourceContentHash } from "@agentflow/research";
import {
  beginHarnessLlmOperation,
  claimOperation,
  completeHarnessLlmOperation,
  completeOperation,
  controlRun,
  createRun,
  enforceRunBudget,
  executeDeterministicOperation,
  executeToolOperation,
  prepareToolExecution,
  publishToControlledReceiver,
  renewOperationLease,
  repairScheduling,
  settleOperationFailure,
  RetryableOperationError,
  type ExecutionFaultHooks,
} from "../../packages/runtime/src/index.ts";
import { Queue, QueueEvents, type Job, type Worker } from "bullmq";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://agentflow:agentflow@localhost:5432/agentflow_test";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const testCredentials: Credential[] = [
  { id: "test-owner", tokenHash: createHash("sha256").update("owner-test-token").digest("hex"), roles: ["release-manager", "research-reviewer", "operator"] },
  { id: "test-owner", tokenHash: createHash("sha256").update("reader-test-token").digest("hex"), roles: [] },
  { id: "other-owner", tokenHash: createHash("sha256").update("other-test-token").digest("hex"), roles: ["release-manager", "operator"] },
];
const testAuthorization = "Bearer owner-test-token";

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
    headers: { "content-type": "application/json", authorization: testAuthorization, ...init?.headers },
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function rawRequest(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: testAuthorization, ...init?.headers },
  });
}

async function restartApi(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server = createApp(database, queue, testCredentials).listen(0);
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

  const app = createApp(database, queue, testCredentials);
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
  it("authenticates callers, isolates ownership, and ignores forged reviewer identities", async () => {
    expect((await rawRequest("/runs", { headers: { authorization: "" } })).status).toBe(401);
    expect((await rawRequest("/runs", { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
    const { run, approval } = await createApprovalRun("ownership-test");
    const other = { authorization: "Bearer other-test-token" };
    for (const suffix of ["", "/history", "/attempts", "/approvals", "/sources", "/usage", "/tool-executions", "/harness-operations"]) {
      expect((await rawRequest(`/runs/${run.id}${suffix}`, { headers: other })).status).toBe(404);
    }
    for (const command of ["pause", "resume", "cancel"]) {
      expect((await rawRequest(`/runs/${run.id}/${command}`, { method: "POST", headers: other })).status).toBe(404);
    }
    const listed = await request<{ runs: Array<{ id: string }> }>("/runs", { headers: other });
    expect(listed.runs.some((entry) => entry.id === run.id)).toBe(false);
    const decision = { decisionRequestId: randomUUID(), decision: "APPROVE", proposalHash: approval.proposalHash, payloadHash: approval.payloadHash };
    expect((await rawRequest(`/approvals/${approval.id}/decisions`, { method: "POST", headers: other, body: JSON.stringify(decision) })).status).toBe(404);
    expect((await rawRequest(`/approvals/${approval.id}/decisions`, { method: "POST", headers: {
      authorization: "Bearer reader-test-token", "x-agentflow-reviewer-id": "admin", "x-agentflow-reviewer-role": "release-manager",
    }, body: JSON.stringify(decision) })).status).toBe(403);
    await request(`/runs/${run.id}/cancel`, { method: "POST" });
  });

  it("rejects malformed and oversized request bodies as client errors", async () => {
    const malformed = await rawRequest("/workflows", { method: "POST", body: "{not json" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "INVALID_REQUEST_BODY" });
    const oversized = await rawRequest("/workflows", {
      method: "POST",
      body: JSON.stringify({ name: "x", description: "y".repeat(1_100_000) }),
    });
    expect(oversized.status).toBe(413);
    expect((await rawRequest("/runs/not-a-uuid")).status).toBe(400);
  });

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
    await worker.pause();
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
    await worker.pause();
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

  it("replays journalled LLM responses across attempts and accounts for saved and orphaned calls", async () => {
    await worker.pause();
    try {
      const workflow = await request<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ name: "llm-journal-workflow", description: "LLM journal replay" }),
      });
      const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          definition: {
            steps: [{
              key: "journal-agent",
              kind: "AGENT",
              handler: "agent",
              provider: "fake",
              model: "fake-model",
              instructions: "Test the LLM journal.",
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
          input: { topic: "journal replay" },
          creationKey: "integration-llm-journal",
        }),
      });
      const step = created.steps[0]!;
      const job = {
        runId: created.id,
        operationId: step.id,
        workflowVersionId: version.id,
        dispatchGeneration: step.dispatchGeneration,
      };
      // Simulates a worker crash: the lease expires and a new attempt is claimed at a higher epoch.
      const crashAndReclaim = async (generation: number, workerId: string) => {
        await database.query(
          "UPDATE workflow_steps SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
          [step.id],
        );
        await repairScheduling(database, 10_000);
        await database.query(
          "UPDATE workflow_steps SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
          [step.id],
        );
        await repairScheduling(database, 10_000);
        const next = await claimOperation(database, { ...job, dispatchGeneration: generation }, workerId, 15_000);
        expect(next).not.toBeNull();
        return next!;
      };
      const request0 = { model: "fake-model", messages: [{ role: "user", content: "turn one" }] };
      const key0 = { hashVersion: 2, provider: "fake", adapterVersion: "1.0.0", ...request0, tools: [], params: {} };
      const usage = {
        provenance: "reported" as const,
        inputTokens: 40,
        outputTokens: 9,
        cachedInputTokens: 0,
        reasoningTokens: null,
        totalTokens: 49,
        raw: { input_tokens: 40, output_tokens: 9 },
      };
      const turnOne = { ordinal: 0, turn: 1, maxTurns: 3, provider: "fake", adapterVersion: "1.0.0", model: "fake-model" };

      const first = await claimOperation(database, job, "journal-worker-1", 15_000);
      const begun = await beginHarnessLlmOperation(database, first!, { ...turnOne, request: request0, journalKey: key0 });
      if (begun.replayed) throw new Error("Expected a new provider call");
      expect(begun.orphanedCalls).toBe(0);
      const output = { text: "journalled", toolCalls: [], finishReason: "stop", usage };
      await completeHarnessLlmOperation(database, first!, begun.providerCallId, {
        output, continuationState: null, providerRequestId: "journal-1", resolvedModel: "fake-model-v1",
        finishReason: "stop", usage,
      });
      const storedVersion = await database.query<{ request_hash_version: number }>(
        "SELECT request_hash_version FROM harness_operations WHERE id = $1",
        [begun.harnessOperationId],
      );
      expect(storedVersion.rows[0]?.request_hash_version).toBe(2);

      // Crash after the journal commit, before the step checkpoint (E2B): the next attempt replays.
      const second = await crashAndReclaim(2, "journal-worker-2");
      const replay = await beginHarnessLlmOperation(database, second, { ...turnOne, request: request0, journalKey: key0 });
      expect(replay).toMatchObject({
        replayed: true,
        output,
        savedUsage: {
          provenance: "reported", inputTokens: 40, outputTokens: 9, totalTokens: 49,
          sourceProviderCallId: begun.providerCallId,
        },
      });
      // A second begin in the same attempt is not double-counted.
      expect(await beginHarnessLlmOperation(database, second, { ...turnOne, request: request0, journalKey: key0 }))
        .toMatchObject({ replayed: true });
      // A changed request (different tool set) never replays the stored response.
      await expect(beginHarnessLlmOperation(database, second, {
        ...turnOne, request: request0, journalKey: { ...key0, tools: [{ name: "search", version: "1" }] },
      })).rejects.toThrow("different request data");
      // A v2 row cannot be matched by a caller that only supplies the legacy request hash.
      await expect(beginHarnessLlmOperation(database, second, { ...turnOne, request: request0 }))
        .rejects.toThrow("different request data");

      // Turn two starts, then the worker crashes before the response is journalled (E2a window).
      const request2 = { model: "fake-model", messages: [{ role: "user", content: "turn two" }] };
      const turnTwo = { ...turnOne, ordinal: 2, turn: 2 };
      const lost = await beginHarnessLlmOperation(database, second, {
        ...turnTwo, request: request2, journalKey: { ...key0, messages: request2.messages },
      });
      if (lost.replayed) throw new Error("Expected a new provider call");

      const third = await crashAndReclaim(3, "journal-worker-3");
      // The stale attempt can no longer touch the journal.
      await expect(beginHarnessLlmOperation(database, second, { ...turnOne, request: request0, journalKey: key0 }))
        .rejects.toThrow("lease fencing");
      const reissued = await beginHarnessLlmOperation(database, third, {
        ...turnTwo, request: request2, journalKey: { ...key0, messages: request2.messages },
      });
      if (reissued.replayed) throw new Error("A lost response must be re-issued, not replayed");
      expect(reissued.orphanedCalls).toBe(1);

      // Rows written before migration 0014 (hash v1) still replay after the upgrade.
      const request4 = { model: "fake-model", messages: [{ role: "user", content: "turn three" }] };
      const turnThree = { ...turnOne, ordinal: 4, turn: 3 };
      const legacy = await beginHarnessLlmOperation(database, third, { ...turnThree, request: request4 });
      if (legacy.replayed) throw new Error("Expected a new provider call");
      await completeHarnessLlmOperation(database, third, legacy.providerCallId, {
        output, continuationState: null, providerRequestId: "journal-legacy", resolvedModel: "fake-model-v1",
        finishReason: "stop", usage,
      });
      expect(await beginHarnessLlmOperation(database, third, {
        ...turnThree, request: request4, journalKey: { ...key0, messages: request4.messages },
      })).toMatchObject({ replayed: true });

      const replays = await database.query<{ attempt_id: string; saved_input_tokens: number }>(
        "SELECT attempt_id, saved_input_tokens FROM harness_replays WHERE run_id = $1 ORDER BY created_at",
        [created.id],
      );
      expect(replays.rows).toEqual([
        { attempt_id: second.attemptId, saved_input_tokens: 40 },
        { attempt_id: third.attemptId, saved_input_tokens: 40 },
      ]);
      await expect(database.query("UPDATE harness_replays SET saved_input_tokens = 0 WHERE run_id = $1", [created.id]))
        .rejects.toThrow("immutable");

      const history = await request<{ events: Array<{ type: string; payload: Record<string, unknown> }> }>(
        `/runs/${created.id}/history`,
      );
      expect(history.events.filter((event) => event.type === "LLM_JOURNAL_REPLAYED")).toHaveLength(2);
      expect(history.events.filter((event) => event.type === "LLM_JOURNAL_ORPHANED")).toHaveLength(1);

      const usageResponse = await request<{
        usage: Array<{ provenance: string; totalTokens: number | null }>;
        replays: Array<{ savedInputTokens: number; savedOutputTokens: number; savedTotalTokens: number | null }>;
        summary: Record<string, unknown>;
      }>(`/runs/${created.id}/usage`);
      // Billed rows: turn one, the lost turn-two call (unknown), turn three. Replays never add billed rows.
      expect(usageResponse.usage.map((record) => record.provenance).sort()).toEqual(["reported", "reported", "unknown"]);
      expect(usageResponse.usage.map((record) => record.totalTokens).sort()).toEqual([49, 49, null]);
      expect(usageResponse.replays.map((replay) => replay.savedTotalTokens)).toEqual([49, 49]);
      const totals = {
        billedCalls: 3,
        unreportedCalls: 1,
        billedInputTokens: 80,
        billedOutputTokens: 18,
        billedCachedInputTokens: 0,
        billedReasoningTokens: 0,
        replayedCalls: 2,
        savedByReplayInputTokens: 80,
        savedByReplayOutputTokens: 18,
        cacheHitCalls: 0,
        savedByCacheInputTokens: 0,
        savedByCacheOutputTokens: 0,
      };
      // Turns one and two looked up the cache and missed; turn three is a legacy (v1) row.
      const cacheLookups = { hits: 0, misses: 2, off: 0 };
      expect(usageResponse.summary).toEqual({
        ...totals,
        provenance: { reported: 2, estimated: 0, unknown: 1 },
        cacheScope: "run",
        cacheLookups,
        budget: null,
        byStep: [{ stepId: step.id, ...totals, cacheLookups }],
        byModel: [
          {
            provider: "fake", model: "fake-model-v1", ...totals,
            billedCalls: 2, unreportedCalls: 0,
          },
          {
            provider: "fake", model: "fake-model", ...totals,
            billedCalls: 1, unreportedCalls: 1, billedInputTokens: 0, billedOutputTokens: 0,
            replayedCalls: 0, savedByReplayInputTokens: 0, savedByReplayOutputTokens: 0,
          },
        ],
      });
      await controlRun(database, created.id, "cancel");
    } finally {
      await worker.resume();
    }
  }, 30_000);

  it("answers identical LLM requests from the response cache only within its configured scope", async () => {
    await worker.pause();
    try {
      const agentStep = (key: string) => ({
        key, kind: "AGENT", handler: "agent", provider: "fake", model: "fake-model",
        instructions: "Cache test.", allowedTools: [], maxTurns: 2,
      });
      const createVersion = async (name: string, cacheScope: string | undefined, steps: number) => {
        const workflow = await request<{ id: string }>("/workflows", {
          method: "POST",
          body: JSON.stringify({ name, description: "Response cache" }),
        });
        return request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
          method: "POST",
          body: JSON.stringify({
            version: 1,
            definition: {
              ...(cacheScope === undefined ? {} : { cacheScope }),
              steps: Array.from({ length: steps }, (_, index) => agentStep(`agent-${index + 1}`)),
            },
          }),
        });
      };
      const startRun = async (versionId: string, creationKey: string) => request<{ id: string }>("/runs", {
        method: "POST",
        body: JSON.stringify({ workflowVersionId: versionId, input: { topic: "cache" }, creationKey }),
      });
      const claimStep = async (runId: string, versionId: string, position: number, workerId: string) => {
        const step = await database.query<{ id: string; dispatch_generation: number }>(
          "SELECT id, dispatch_generation FROM workflow_steps WHERE run_id = $1 AND position = $2",
          [runId, position],
        );
        const claimed = await claimOperation(database, {
          runId, operationId: step.rows[0]!.id, workflowVersionId: versionId,
          dispatchGeneration: step.rows[0]!.dispatch_generation,
        }, workerId, 15_000);
        expect(claimed).not.toBeNull();
        return claimed!;
      };
      const request0 = { model: "fake-model", messages: [{ role: "user", content: "identical prompt" }] };
      const key = { hashVersion: 2, provider: "fake", adapterVersion: "1.0.0", ...request0, tools: [], params: { temperature: null } };
      const turn = { ordinal: 0, turn: 1, maxTurns: 2, provider: "fake", adapterVersion: "1.0.0", model: "fake-model", request: request0 };
      const usage = {
        provenance: "reported" as const, inputTokens: 30, outputTokens: 5, cachedInputTokens: 0,
        reasoningTokens: null, totalTokens: 35, raw: {},
      };
      const output = { text: "cached answer", toolCalls: [], finishReason: "stop", usage };
      const callAndComplete = async (claimed: Awaited<ReturnType<typeof claimStep>>, journalKey = key) => {
        const begun = await beginHarnessLlmOperation(database, claimed, { ...turn, journalKey });
        if (begun.replayed) throw new Error("Expected a provider call");
        await completeHarnessLlmOperation(database, claimed, begun.providerCallId, {
          output, continuationState: null, providerRequestId: `req-${begun.providerCallId}`,
          resolvedModel: "fake-model-v1", finishReason: "stop", usage,
        });
        return begun;
      };
      const providerCallsFor = async (runId: string) => Number((await database.query<{ count: string }>(
        `SELECT count(*) FROM provider_calls pc JOIN harness_operations ho ON ho.id = pc.harness_operation_id
         WHERE ho.run_id = $1`, [runId],
      )).rows[0]!.count);

      // 1. Run scope (the default): a second step with an identical request in the same run hits.
      const runScoped = await createVersion("cache-run-scope", undefined, 2);
      const runA = await startRun(runScoped.id, "cache-run-a");
      const stepOne = await claimStep(runA.id, runScoped.id, 0, "cache-worker");
      const original = await callAndComplete(stepOne);
      expect(original.cacheLookup).toBe("MISS");
      await completeOperation(database, stepOne, { done: true });
      const stepTwo = await claimStep(runA.id, runScoped.id, 1, "cache-worker");
      const hit = await beginHarnessLlmOperation(database, stepTwo, { ...turn, journalKey: key });
      expect(hit).toMatchObject({
        replayed: true,
        output,
        cacheHit: { scope: "run", sourceHarnessOperationId: original.harnessOperationId },
        savedUsage: { inputTokens: 30, outputTokens: 5, provenance: "reported" },
      });
      expect(await providerCallsFor(runA.id)).toBe(1);
      // A crash after the hit replays it from the journal without counting the saving twice.
      expect(await beginHarnessLlmOperation(database, stepTwo, { ...turn, journalKey: key }))
        .toMatchObject({ replayed: true, cacheHit: null, savedUsage: null });

      // 2. The default scope never crosses runs.
      const runB = await startRun(runScoped.id, "cache-run-b");
      const crossRun = await callAndComplete(await claimStep(runB.id, runScoped.id, 0, "cache-worker"));
      expect(crossRun.cacheLookup).toBe("MISS");

      // 3. Version scope: another run of the same version hits; a different version misses.
      const versionScoped = await createVersion("cache-version-scope", "version", 1);
      const runC = await startRun(versionScoped.id, "cache-version-c");
      await callAndComplete(await claimStep(runC.id, versionScoped.id, 0, "cache-worker"));
      const runD = await startRun(versionScoped.id, "cache-version-d");
      const claimedD = await claimStep(runD.id, versionScoped.id, 0, "cache-worker");
      expect(await beginHarnessLlmOperation(database, claimedD, { ...turn, journalKey: key }))
        .toMatchObject({ replayed: true, cacheHit: { scope: "version" } });
      expect(await providerCallsFor(runD.id)).toBe(0);
      const otherVersion = await createVersion("cache-version-other", "version", 1);
      const runE = await startRun(otherVersion.id, "cache-version-e");
      expect((await callAndComplete(await claimStep(runE.id, otherVersion.id, 0, "cache-worker"))).cacheLookup).toBe("MISS");

      // 4. A different sampling parameter or tool set is a different request: no hit.
      const runF = await startRun(versionScoped.id, "cache-version-f");
      const differentTemperature = await beginHarnessLlmOperation(database, await claimStep(runF.id, versionScoped.id, 0, "cache-worker"), {
        ...turn, journalKey: { ...key, params: { temperature: 0 } },
      });
      expect(differentTemperature).toMatchObject({ replayed: false, cacheLookup: "MISS" });
      const runG = await startRun(versionScoped.id, "cache-version-g");
      expect(await beginHarnessLlmOperation(database, await claimStep(runG.id, versionScoped.id, 0, "cache-worker"), {
        ...turn, journalKey: { ...key, tools: [{ name: "search", version: "1" }] },
      })).toMatchObject({ replayed: false, cacheLookup: "MISS" });

      // 5. An in-flight (never accepted) response is never served: runF's call has no result.
      const sameAsF = { ...key, params: { temperature: 0 } };
      const runH = await startRun(versionScoped.id, "cache-version-h");
      expect(await beginHarnessLlmOperation(database, await claimStep(runH.id, versionScoped.id, 0, "cache-worker"), {
        ...turn, journalKey: sameAsF,
      })).toMatchObject({ replayed: false, cacheLookup: "MISS" });

      // 6. "off" always calls the provider, even for an identical in-run request.
      const offScoped = await createVersion("cache-off-scope", "off", 2);
      const runI = await startRun(offScoped.id, "cache-off-i");
      const offOne = await claimStep(runI.id, offScoped.id, 0, "cache-worker");
      expect((await callAndComplete(offOne)).cacheLookup).toBe("OFF");
      await completeOperation(database, offOne, { done: true });
      expect((await callAndComplete(await claimStep(runI.id, offScoped.id, 1, "cache-worker"))).cacheLookup).toBe("OFF");
      expect(await providerCallsFor(runI.id)).toBe(2);

      // 7. Audit trail and usage summary keep cache savings apart from journal replay.
      const history = await request<{ events: Array<{ type: string; payload: Record<string, unknown> }> }>(`/runs/${runA.id}/history`);
      expect(history.events.filter((event) => event.type === "LLM_CACHE_HIT")).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ source: "CACHE_RUN", sourceHarnessOperationId: original.harnessOperationId }) }),
      ]);
      const summaryA = (await request<{ summary: Record<string, unknown>; replays: Array<{ source: string }> }>(`/runs/${runA.id}/usage`));
      expect(summaryA.replays.map((replay) => replay.source)).toEqual(["CACHE_RUN"]);
      expect(summaryA.summary).toMatchObject({
        billedCalls: 1,
        replayedCalls: 0,
        cacheHitCalls: 1,
        savedByCacheInputTokens: 30,
        savedByCacheOutputTokens: 5,
        cacheScope: "run",
        cacheLookups: { hits: 1, misses: 1, off: 0 },
      });
      const summaryD = (await request<{ summary: Record<string, unknown> }>(`/runs/${runD.id}/usage`)).summary;
      expect(summaryD).toMatchObject({ billedCalls: 0, cacheHitCalls: 1, cacheScope: "version", cacheLookups: { hits: 1, misses: 0, off: 0 } });
      const summaryI = (await request<{ summary: Record<string, unknown> }>(`/runs/${runI.id}/usage`)).summary;
      expect(summaryI).toMatchObject({ billedCalls: 2, cacheHitCalls: 0, cacheScope: "off", cacheLookups: { hits: 0, misses: 0, off: 2 } });

      for (const run of [runA, runB, runC, runD, runE, runF, runG, runH, runI]) {
        await controlRun(database, run.id, "cancel");
      }
    } finally {
      await worker.resume();
    }
  }, 30_000);

  it("sends only declared agent inputs to the provider while the step output keeps the full state", async () => {
    await worker.pause();
    try {
      const workflow = await request<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ name: "context-minimization-workflow", description: "Declared agent inputs" }),
      });
      const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          definition: {
            steps: [{
              key: "minimal-agent", kind: "AGENT", handler: "agent", provider: "fake", model: "fake-model",
              instructions: "Use only what you are given.", allowedTools: [], maxTurns: 1,
              outputKey: "analysis", inputs: ["topic", "nested.keep", "nested.absent"],
            }],
          },
        }),
      });
      const runWith = async (input: Record<string, unknown>, creationKey: string) => {
        const created = await request<{ id: string; steps: Array<{ id: string; dispatchGeneration: number }> }>("/runs", {
          method: "POST",
          body: JSON.stringify({ workflowVersionId: version.id, input, creationKey }),
        });
        const fake = new DeterministicFakeProvider();
        const harness = new AgentHarness(new ProviderRegistry().register(fake), new ToolRegistry());
        const step = created.steps[0]!;
        const result = await processOperationJob(
          database, "context-worker", 15_000,
          { data: { runId: created.id, operationId: step.id, workflowVersionId: version.id, dispatchGeneration: step.dispatchGeneration } } as Job,
          5_000, 60_000, harness,
        );
        return { created, fake, result };
      };

      const full = { topic: "pricing", nested: { keep: "yes", drop: "no" }, publicationTarget: "controlled://publications/x" };
      const ok = await runWith(full, "context-minimization-ok");
      expect(ok.result).toMatchObject({ skipped: false, runCompleted: true });
      expect(ok.fake.calls).toHaveLength(1);
      // Only the declared paths reach the provider; the absent optional path is omitted.
      expect(JSON.parse(ok.fake.calls[0]!.request.messages[0]!.content)).toEqual({ topic: "pricing", nested: { keep: "yes" } });
      const completed = await request<{ steps: Array<{ acceptedOutput: Record<string, unknown> }> }>(`/runs/${ok.created.id}`);
      expect(completed.steps[0]?.acceptedOutput).toMatchObject({
        ...full,
        analysis: expect.objectContaining({ content: "fake-response-1" }),
      });

      // A declared root missing at runtime is a definition bug: permanent failure, no provider call.
      const missing = await runWith({ nested: { keep: "yes" } }, "context-minimization-missing");
      expect(missing.result).toMatchObject({ failed: true, failure: { errorClass: "PERMANENT", code: "DECLARED_INPUT_MISSING" } });
      expect(missing.fake.calls).toHaveLength(0);
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("enforces run token and cost budgets from persisted usage and ends the run BUDGET_EXCEEDED", async () => {
    await worker.pause();
    try {
      const workflow = await request<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ name: "budget-workflow", description: "Run budgets" }),
      });
      const agentStep = (key: string, outputKey: string) => ({
        key, kind: "AGENT", handler: "agent", provider: "fake", model: "fake-model",
        instructions: `Budget ${key}.`, allowedTools: [], maxTurns: 1, outputKey,
      });
      const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
        method: "POST",
        body: JSON.stringify({ version: 1, definition: { steps: [agentStep("first", "one"), agentStep("second", "two")] } }),
      });
      // Every fake call reports 40 input + 20 output = 60 billed tokens.
      const billed: LLMResponse = {
        text: "ok", toolCalls: [], finishReason: "stop",
        usage: { provenance: "reported", inputTokens: 40, outputTokens: 20, cachedInputTokens: 0, reasoningTokens: 0, raw: {} },
        providerRequestId: null, resolvedModel: "fake-model", opaqueState: null,
      };
      const processStep = async (runId: string, position: number) => {
        const step = await database.query<{ id: string; dispatch_generation: number }>(
          "SELECT id, dispatch_generation FROM workflow_steps WHERE run_id = $1 AND position = $2",
          [runId, position],
        );
        const fake = new DeterministicFakeProvider([billed]);
        const harness = new AgentHarness(new ProviderRegistry().register(fake), new ToolRegistry());
        const result = await processOperationJob(
          database, "budget-worker", 15_000,
          { data: { runId, operationId: step.rows[0]!.id, workflowVersionId: version.id, dispatchGeneration: step.rows[0]!.dispatch_generation } } as Job,
          5_000, 60_000, harness,
        );
        return { result, fake, stepId: step.rows[0]!.id };
      };
      const startRun = (body: Record<string, unknown>) => request<{ id: string; maxTokens: number | null }>("/runs", {
        method: "POST",
        body: JSON.stringify({ workflowVersionId: version.id, input: { topic: "budget" }, ...body }),
      });
      const runState = async (runId: string) => request<{
        lifecycle: string; publicStatus: string; failure: Record<string, unknown> | null;
      }>(`/runs/${runId}`);
      const events = async (runId: string, type: string) =>
        (await request<{ events: Array<{ type: string; payload: Record<string, unknown> }> }>(`/runs/${runId}/history`))
          .events.filter((event) => event.type === type);

      // 1. A response that pushes usage past the budget ends the run after that response.
      const over = await startRun({ maxTokens: 50, creationKey: "budget-over" });
      expect(over.maxTokens).toBe(50);
      const first = await processStep(over.id, 0);
      expect(first.result).toMatchObject({ budgetExceeded: true });
      expect(first.fake.calls).toHaveLength(1);
      expect(await runState(over.id)).toMatchObject({ lifecycle: "BUDGET_EXCEEDED", publicStatus: "BUDGET_EXCEEDED" });
      expect(await events(over.id, "RUN_BUDGET_EXCEEDED")).toEqual([expect.objectContaining({
        payload: expect.objectContaining({ code: "RUN_BUDGET_EXCEEDED", phase: "after-response", tokensUsed: 60, maxTokens: 50 }),
      })]);
      const attempt = await database.query<{ status: string; error_class: string }>(
        "SELECT status, error_class FROM step_attempts WHERE step_id = $1", [first.stepId],
      );
      expect(attempt.rows).toEqual([{ status: "FAILED", error_class: "PERMANENT" }]);
      const secondStep = await database.query("SELECT 1 FROM workflow_steps WHERE run_id = $1 AND position = 1", [over.id]);
      expect(secondStep.rowCount).toBe(0);

      // 2. Landing exactly on the budget completes the step; the next call is never sent.
      const exact = await startRun({ maxTokens: 60 });
      expect((await processStep(exact.id, 0)).result).toMatchObject({ skipped: false, runCompleted: false });
      const stopped = await processStep(exact.id, 1);
      expect(stopped.result).toMatchObject({ budgetExceeded: true, budget: { phase: "before-call", tokensUsed: 60 } });
      expect(stopped.fake.calls).toHaveLength(0);
      const unsent = await database.query<{ status: string; error_json: Record<string, unknown> }>(
        `SELECT pc.status, pc.error_json FROM provider_calls pc WHERE pc.step_id = $1`, [stopped.stepId],
      );
      expect(unsent.rows).toEqual([{ status: "FAILED", error_json: { code: "RUN_BUDGET_EXCEEDED", sent: false } }]);
      const exactUsage = await request<{ usage: unknown[]; summary: { budget: Record<string, unknown> } }>(`/runs/${exact.id}/usage`);
      expect(exactUsage.usage).toHaveLength(1);
      expect(exactUsage.summary.budget).toMatchObject({ maxTokens: 60, tokensUsed: 60, maxCostUsd: null, costUsd: null });
      expect((await runState(exact.id)).publicStatus).toBe("BUDGET_EXCEEDED");

      // 3. Under budget the run succeeds normally.
      const under = await startRun({ maxTokens: 1_000 });
      await processStep(under.id, 0);
      expect((await processStep(under.id, 1)).result).toMatchObject({ runCompleted: true });
      expect((await runState(under.id)).lifecycle).toBe("SUCCEEDED");

      // 4. Cost budgets need a configured price; this API has none, so creation is refused.
      const unpriced = await rawRequest("/runs", {
        method: "POST",
        body: JSON.stringify({ workflowVersionId: version.id, input: { topic: "budget" }, maxCostUsd: 1 }),
      });
      expect(unpriced.status).toBe(409);
      expect(await unpriced.text()).toContain("fake/fake-model");
      // With a price snapshot, $1000 per 1M tokens makes one 60-token call cost $0.06 > $0.05.
      const priced = await createRun(database, { workflowVersionId: version.id, input: { topic: "budget" }, maxCostUsd: 0.05 },
        { modelPrices: { "fake/fake-model": { inputPer1M: 1_000, outputPer1M: 1_000 } } });
      expect((await processStep(priced.id, 0)).result).toMatchObject({ budgetExceeded: true });
      expect(await events(priced.id, "RUN_BUDGET_EXCEEDED")).toEqual([expect.objectContaining({
        payload: expect.objectContaining({ maxCostUsd: 0.05, costUsd: expect.closeTo(0.06, 9) }),
      })]);

      // 5. Replaying a creation key with a different budget is a conflict.
      const replay = await rawRequest("/runs", {
        method: "POST",
        body: JSON.stringify({ workflowVersionId: version.id, input: { topic: "budget" }, maxTokens: 51, creationKey: "budget-over" }),
      });
      expect(replay.status).toBe(409);

      // 6. A stale lease cannot enforce (and so cannot terminate) a run.
      const fenced = await startRun({ maxTokens: 10 });
      const step = await database.query<{ id: string; dispatch_generation: number }>(
        "SELECT id, dispatch_generation FROM workflow_steps WHERE run_id = $1 AND position = 0", [fenced.id],
      );
      const stale = await claimOperation(database, {
        runId: fenced.id, operationId: step.rows[0]!.id, workflowVersionId: version.id,
        dispatchGeneration: step.rows[0]!.dispatch_generation,
      }, "stale-budget-worker", 15_000);
      await database.query("UPDATE workflow_steps SET lease_epoch = lease_epoch + 1 WHERE id = $1", [step.rows[0]!.id]);
      await expect(enforceRunBudget(database, stale!, "before-call")).rejects.toThrow("lease fencing");
      expect((await runState(fenced.id)).lifecycle).toBe("OPEN");
      await controlRun(database, fenced.id, "cancel");
    } finally {
      await worker.resume();
    }
  }, 30_000);

  it("replays a journalled response on retry by default and re-calls the provider only in the no-journal ablation", async () => {
    await worker.pause();
    try {
      const retriedCalls = async (name: string, cacheScope: string | undefined, llmJournalReplay: boolean | undefined) => {
        const workflow = await request<{ id: string }>("/workflows", {
          method: "POST",
          body: JSON.stringify({ name, description: "Journal ablation" }),
        });
        const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
          method: "POST",
          body: JSON.stringify({
            version: 1,
            definition: {
              ...(cacheScope ? { cacheScope } : {}),
              steps: [{ key: "agent", kind: "AGENT", handler: "agent", provider: "fake", model: "fake-model",
                instructions: "Journal ablation.", allowedTools: [], maxTurns: 1 }],
            },
          }),
        });
        const created = await request<{ id: string }>("/runs", {
          method: "POST",
          body: JSON.stringify({ workflowVersionId: version.id, input: { topic: name },
            retryPolicy: { maxAttempts: 3, initialBackoffMs: 0, multiplier: 1, maxBackoffMs: 0 } }),
        });
        const options = llmJournalReplay === undefined ? {} : { llmJournalReplay };
        const process = async (faultHooks?: ExecutionFaultHooks) => {
          const step = await database.query<{ id: string; dispatch_generation: number }>(
            "SELECT id, dispatch_generation FROM workflow_steps WHERE run_id = $1", [created.id]);
          const fake = new DeterministicFakeProvider();
          const result = await processOperationJob(
            database, "journal-ablation-worker", 15_000,
            { data: { runId: created.id, operationId: step.rows[0]!.id, workflowVersionId: version.id, dispatchGeneration: step.rows[0]!.dispatch_generation } } as Job,
            5_000, 60_000, new AgentHarness(new ProviderRegistry().register(fake), new ToolRegistry()), faultHooks, options,
          );
          return { result, calls: fake.calls.length, stepId: step.rows[0]!.id };
        };
        // Attempt 1 journals the response, then fails transiently before the step commits.
        const first = await process({
          hit(boundary) {
            if (boundary === "after-llm-journal-commit") throw new RetryableOperationError("injected", "INJECTED_TRANSIENT");
          },
        });
        expect(first).toMatchObject({ calls: 1, result: { failed: true } });
        await database.query("UPDATE workflow_steps SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [first.stepId]);
        await repairScheduling(database, 10_000);
        const second = await process();
        expect(second.result).toMatchObject({ runCompleted: true });
        return second.calls;
      };
      expect(await retriedCalls("journal-ablation-default", undefined, undefined)).toBe(0);
      expect(await retriedCalls("journal-ablation-off", "off", false)).toBe(1);
    } finally {
      await worker.resume();
    }
  }, 30_000);

  it("filters the owner's runs by public status, workflow and creation time", async () => {
    await worker.pause();
    try {
      const makeVersion = async (name: string, authorization = testAuthorization) => {
        const headers = { authorization };
        const workflow = await request<{ id: string }>("/workflows", { method: "POST", headers, body: JSON.stringify({ name, description: "Run filters" }) });
        const version = await request<{ id: string }>(`/workflows/${workflow.id}/versions`, {
          method: "POST", headers, body: JSON.stringify({ version: 1, definition: defaultWorkflowDefinition }),
        });
        return { workflowId: workflow.id, versionId: version.id };
      };
      const startRun = (versionId: string, authorization = testAuthorization) =>
        request<{ id: string }>("/runs", { method: "POST", headers: { authorization }, body: JSON.stringify({ workflowVersionId: versionId, input: { topic: "filters" } }) });
      type RunList = { runs: Array<{ id: string; publicStatus: string; workflowId: string }>; total: number };

      const first = await makeVersion("filters-first");
      const second = await makeVersion("filters-second");
      const foreign = await makeVersion("filters-foreign", "Bearer other-test-token");
      const queued = await startRun(first.versionId);
      const cancelled = await startRun(first.versionId);
      const other = await startRun(second.versionId);
      const foreignRun = await startRun(foreign.versionId, "Bearer other-test-token");
      await controlRun(database, cancelled.id, "cancel");
      await repairScheduling(database, 10_000);

      const byWorkflow = await request<RunList>(`/runs?workflowId=${first.workflowId}`);
      expect(byWorkflow.runs.map((run) => run.id).sort()).toEqual([queued.id, cancelled.id].sort());
      expect(byWorkflow.total).toBe(2);

      const cancelledOnly = await request<RunList>(`/runs?workflowId=${first.workflowId}&status=CANCELLED`);
      expect(cancelledOnly).toMatchObject({ total: 1, runs: [{ id: cancelled.id, publicStatus: "CANCELLED" }] });
      const activeOnly = await request<RunList>(`/runs?workflowId=${first.workflowId}&status=QUEUED,RUNNING`);
      expect(activeOnly.runs.map((run) => run.id)).toEqual([queued.id]);

      const future = new Date(Date.now() + 60_000).toISOString();
      expect((await request<RunList>(`/runs?workflowId=${second.workflowId}&from=${future}`)).total).toBe(0);
      expect((await request<RunList>(`/runs?workflowId=${second.workflowId}&to=${future}`)).runs.map((run) => run.id)).toEqual([other.id]);

      // Another owner's workflow filter returns nothing for this owner, and never leaks its runs.
      expect((await request<RunList>(`/runs?workflowId=${foreign.workflowId}`)).total).toBe(0);
      const all = await request<RunList>("/runs?limit=100");
      expect(all.runs.some((run) => run.id === foreignRun.id)).toBe(false);
      expect((await rawRequest("/runs?status=lowercase")).status).toBe(400);

      for (const run of [queued, other]) await controlRun(database, run.id, "cancel");
      await controlRun(database, foreignRun.id, "cancel");
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("registers a new reference workflow version when its definition changes instead of failing", async () => {
    const owner = "context-version-owner";
    const full = await ensureCloudComparisonWorkflow(database, { context: "full" }, owner);
    const minimal = await ensureCloudComparisonWorkflow(database, { context: "minimal" }, owner);
    const again = await ensureCloudComparisonWorkflow(database, { context: "minimal" }, owner);
    const fullAgain = await ensureCloudComparisonWorkflow(database, { context: "full" }, owner);
    expect(full).toMatchObject({ version: 1, created: true });
    expect(minimal).toMatchObject({ version: 2, created: true, workflowId: full.workflowId });
    expect(again).toMatchObject({ version: 2, created: false, workflowVersionId: minimal.workflowVersionId });
    expect(fullAgain).toMatchObject({ version: 1, created: false, workflowVersionId: full.workflowVersionId });
  });

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
    await worker.pause();
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
    await worker.pause();
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
    await worker.pause();
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
    await worker.pause();
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
        headers: { "content-type": "application/json", authorization: testAuthorization },
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
    await worker.pause();
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
    await worker.pause();
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
      // Do not leave a retry that becomes due during later tests' global repair assertions.
      await controlRun(database, created.id, "cancel");
    } finally {
      await worker.resume();
    }
  }, 20_000);

  it("serializes resume with a due retry without duplicate dispatch", async () => {
    await worker.pause();
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
    await worker.pause();
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
    await worker.pause();
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
    await worker.pause();
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
        "x-agentflow-reviewer-role": "release-manager",
        authorization: "Bearer reader-test-token",
      },
      body: JSON.stringify(baseDecision),
    });
    expect(wrongRole.status).toBe(403);
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
    await worker.pause();
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
    await worker.pause();
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
      decidedBy: "test-owner",
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
    await worker.pause();
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
    await worker.pause();
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
