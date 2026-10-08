import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../apps/api/src/app.js";
import type { Credential } from "../../apps/api/src/auth.js";
import { redisConnection } from "../../apps/api/src/redis.js";
import { createDatabase, migrate, type Database } from "@agentflow/db";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://agentflow:agentflow@localhost:5432/agentflow_test";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const suffix = randomUUID();
const ownerId = `cli-ep-owner-${suffix}`;
const otherId = `cli-ep-other-${suffix}`;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const testCredentials: Credential[] = [
  { id: ownerId, tokenHash: tokenHash(`owner-${suffix}`), roles: ["release-manager"] },
  { id: ownerId, tokenHash: tokenHash(`reader-${suffix}`), roles: [] },
  { id: otherId, tokenHash: tokenHash(`other-${suffix}`), roles: ["release-manager"] },
];
const OWNER = `owner-${suffix}`;
const READER = `reader-${suffix}`;
const OTHER = `other-${suffix}`;

function assertTestDatabaseUrl(connectionString: string): void {
  const databaseName = new URL(connectionString).pathname.slice(1);
  if (!/(?:_|-)test$/.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}".`);
  }
}

let database: Database;
let queue: Queue;
let server: Server;
let baseUrl: string;

async function call(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init?.headers },
  });
}

async function json<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await call(token, path, init);
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function createApprovalRun(name: string, expiresAfterMs = 60_000) {
  const workflow = await json<{ id: string }>(OWNER, "/workflows", {
    method: "POST",
    body: JSON.stringify({ name, description: "CLI endpoints" }),
  });
  const version = await json<{ id: string }>(OWNER, `/workflows/${workflow.id}/versions`, {
    method: "POST",
    body: JSON.stringify({
      version: 1,
      definition: {
        steps: [
          { key: "review", kind: "APPROVAL", handler: "approval", reviewerRole: "release-manager", expiresAfterMs },
          { key: "finalize", kind: "DETERMINISTIC", handler: "finalize" },
        ],
      },
    }),
  });
  const run = await json<{ id: string }>(OWNER, "/runs", {
    method: "POST",
    body: JSON.stringify({ workflowVersionId: version.id, input: { release: name } }),
  });
  return { workflow, version, run };
}

beforeAll(async () => {
  assertTestDatabaseUrl(databaseUrl);
  database = createDatabase(databaseUrl);
  await migrate(database);
  queue = new Queue("cli-endpoints-queue", { connection: redisConnection(redisUrl) });
  server = createApp(database, queue, testCredentials).listen(0);
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await queue?.close();
  await database?.end();
});

describe("GET /workflows and GET /workflows/:id", () => {
  let publishedId: string;
  let bareId: string;

  beforeAll(async () => {
    const { workflow } = await createApprovalRun(`cli-ep-published-${suffix}`);
    publishedId = workflow.id;
    const bare = await json<{ id: string }>(OWNER, "/workflows", {
      method: "POST",
      body: JSON.stringify({ name: `cli-ep-bare-${suffix}` }),
    });
    bareId = bare.id;
  });

  it("lists the caller's workflows with version stats", async () => {
    const body = await json<{ workflows: Array<{ id: string; latestVersion: number | null; versionCount: number }> }>(
      OWNER, "/workflows",
    );
    const published = body.workflows.find((w) => w.id === publishedId);
    const bare = body.workflows.find((w) => w.id === bareId);
    expect(published).toMatchObject({ latestVersion: 1, versionCount: 1 });
    expect(bare).toMatchObject({ latestVersion: null, versionCount: 0 });
  });

  it("hides other owners' workflows from the list", async () => {
    const body = await json<{ workflows: Array<{ id: string }> }>(OTHER, "/workflows");
    const ids = body.workflows.map((w) => w.id);
    expect(ids).not.toContain(publishedId);
    expect(ids).not.toContain(bareId);
  });

  it("returns workflow detail with versions and step counts", async () => {
    const body = await json<{ id: string; versions: Array<{ version: number; stepCount: number; id: string }> }>(
      OWNER, `/workflows/${publishedId}`,
    );
    expect(body.id).toBe(publishedId);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({ version: 1, stepCount: 2 });
  });

  it("returns 404 for another owner's or unknown workflow and 400 for a bad id", async () => {
    const foreign = await call(OTHER, `/workflows/${publishedId}`);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "NOT_FOUND" });
    expect((await call(OWNER, `/workflows/${randomUUID()}`)).status).toBe(404);
    expect((await call(OWNER, "/workflows/not-a-uuid")).status).toBe(400);
  });
});

describe("GET /approvals", () => {
  let runId: string;

  beforeAll(async () => {
    ({ run: { id: runId } } = await createApprovalRun(`cli-ep-approval-${suffix}`));
  });

  it("lists pending approvals for the caller's runs and roles", async () => {
    const body = await json<{ approvals: Array<{ runId: string; status: string; proposalHash: string }> }>(
      OWNER, "/approvals",
    );
    const mine = body.approvals.filter((a) => a.runId === runId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: "PENDING" });
    expect(mine[0]?.proposalHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns nothing to a principal without the reviewer role", async () => {
    const body = await json<{ approvals: unknown[] }>(READER, "/approvals");
    expect(body.approvals).toEqual([]);
  });

  it("hides approvals on other owners' runs", async () => {
    const body = await json<{ approvals: Array<{ runId: string }> }>(OTHER, "/approvals");
    expect(body.approvals.some((a) => a.runId === runId)).toBe(false);
  });

  it("filters by runId and validates it", async () => {
    const body = await json<{ approvals: Array<{ runId: string }> }>(OWNER, `/approvals?runId=${runId}`);
    expect(body.approvals.map((a) => a.runId)).toEqual([runId]);
    expect((await call(OWNER, "/approvals?runId=bad")).status).toBe(400);
  });

  it("omits expired approvals", async () => {
    const { run } = await createApprovalRun(`cli-ep-expiring-${suffix}`, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const body = await json<{ approvals: Array<{ runId: string }> }>(OWNER, "/approvals");
    expect(body.approvals.some((a) => a.runId === run.id)).toBe(false);
  });
});
