import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "../../apps/cli/src/api-client.js";
import { CliError } from "../../apps/cli/src/errors.js";
import { Output } from "../../apps/cli/src/output/emit.js";
import { resolveRunId } from "../../apps/cli/src/resolve-id.js";
import { run } from "../../apps/cli/src/run.js";
import { authedIO, fakeIO, startFakeApi, type FakeApi, type FakeResponse, type RecordedRequest } from "./cli-helpers.js";

const VERSION_ID = "cccccccc-0000-4000-8000-000000000003";
const runId = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const TARGET = "deadbeef-1234-4000-8000-000000000001";

let api: FakeApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

async function serve(handler: (request: RecordedRequest) => FakeResponse) {
  api = await startFakeApi(handler);
  return api;
}

function summary(id: string, publicStatus = "RUNNING") {
  return {
    id, workflowVersionId: VERSION_ID, workflowName: "release-flow", workflowVersion: 1,
    lifecycle: "OPEN", control: "NONE", waitReason: "NONE", publicStatus,
    createdAt: "2026-10-08T11:59:00.000Z", finishedAt: null, deadlineAt: "2026-10-08T12:05:00.000Z",
    failure: null, stepCount: 3, completedStepCount: 1, attemptCount: 2, inputTokens: 10, outputTokens: 20,
  };
}

function detail(id: string, publicStatus = "RUNNING") {
  return {
    id, workflowVersionId: VERSION_ID, lifecycle: "OPEN", control: "NONE", waitReason: "NONE", publicStatus,
    input: {}, stateRevision: 1, createdAt: "2026-10-08T11:59:00.000Z", finishedAt: null,
    deadlineAt: "2026-10-08T12:05:00.000Z", failure: null,
    checkpoint: { id: "x", revision: 1, reason: "r", createdAt: "2026-10-08T11:59:00.000Z" },
    steps: [
      { id: "s1", nodeKey: "search-aws", position: 0, kind: "LLM", handler: "h", status: "SUCCEEDED", input: {}, acceptedOutput: null,
        failure: null, attemptCount: 2, maxAttempts: 3, createdAt: "2026-10-08T11:59:00.000Z", completedAt: "2026-10-08T11:59:30.000Z", nextAttemptAt: null },
      { id: "s2", nodeKey: "approve-publication", position: 1, kind: "APPROVAL", handler: "h", status: "WAITING_APPROVAL", input: {}, acceptedOutput: null,
        failure: null, attemptCount: 0, maxAttempts: 3, createdAt: "2026-10-08T11:59:30.000Z", completedAt: null, nextAttemptAt: null },
    ],
  };
}

function testClient(url: string) {
  const fake = fakeIO();
  const out = new Output(fake.io, { json: false, quiet: false, color: false, verbose: false });
  return new ApiClient({ baseUrl: url, io: fake.io, out, auth: { type: "token", token: "t" } });
}

function pagedRuns(total: number, extraIds: string[] = []) {
  const ids = [...Array.from({ length: total - extraIds.length }, (_, i) => runId(i + 1)), ...extraIds];
  return (request: RecordedRequest): FakeResponse => {
    const limit = Number(request.query.limit);
    const offset = Number(request.query.offset);
    return { status: 200, body: { runs: ids.slice(offset, offset + limit).map((id) => summary(id)), total, limit, offset } };
  };
}

describe("resolveRunId", () => {
  it("returns a full UUID without a request", async () => {
    await serve(() => ({ status: 500 }));
    expect(await resolveRunId(testClient(api!.url), TARGET)).toBe(TARGET);
    expect(api!.requests).toEqual([]);
  });

  it("pages through runs to resolve a unique prefix", async () => {
    await serve(pagedRuns(150, [TARGET]));
    expect(await resolveRunId(testClient(api!.url), "deadbeef")).toBe(TARGET);
    expect(api!.requests).toHaveLength(2);
  });

  it("reports an ambiguous prefix as a usage error listing matches", async () => {
    const other = "deadbeef-9999-4000-8000-000000000002";
    await serve(pagedRuns(5, [TARGET, other]));
    const error = await resolveRunId(testClient(api!.url), "deadbeef").catch((e: unknown) => e as CliError);
    expect((error as CliError).exitCode).toBe(2);
    expect((error as CliError).message).toContain(TARGET);
    expect((error as CliError).message).toContain(other);
  });

  it("reports an unknown prefix as not found", async () => {
    await serve(pagedRuns(5));
    const error = await resolveRunId(testClient(api!.url), "ffffffff").catch((e: unknown) => e as CliError);
    expect((error as CliError).exitCode).toBe(4);
  });

  it("rejects prefixes shorter than 8 characters", async () => {
    await serve(pagedRuns(5));
    const error = await resolveRunId(testClient(api!.url), "abc").catch((e: unknown) => e as CliError);
    expect((error as CliError).exitCode).toBe(2);
    expect(api!.requests).toEqual([]);
  });
});

describe("runs start", () => {
  it("merges --input and --set and converts --deadline", async () => {
    await serve(() => ({ status: 201, body: detail(TARGET, "QUEUED") }));
    const fake = await authedIO(api!.url);
    const file = join(fake.dir, "in.json");
    await writeFile(file, JSON.stringify({ topic: "k8s", region: "us" }));
    const code = await run(
      ["runs", "start", VERSION_ID, "--input", file, "--set", 'region="eu"', "--set", "retries=3", "--deadline", "90s"],
      fake.io,
    );
    expect(code).toBe(0);
    expect(api!.requests[0]?.body).toMatchObject({
      workflowVersionId: VERSION_ID,
      input: { topic: "k8s", region: "eu", retries: 3 },
      deadlineMs: 90_000,
    });
    expect(fake.stdout()).toContain(`Started run ${TARGET}`);
  });

  it("validates the deadline client-side", async () => {
    await serve(() => ({ status: 201, body: detail(TARGET) }));
    const fake = await authedIO(api!.url);
    expect(await run(["runs", "start", VERSION_ID, "--deadline", "500ms"], fake.io)).toBe(2);
    expect(api!.requests).toEqual([]);
  });

  it("prints only the id with -q", async () => {
    await serve(() => ({ status: 201, body: detail(TARGET, "QUEUED") }));
    const fake = await authedIO(api!.url);
    expect(await run(["runs", "start", VERSION_ID, "-q"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe(`${TARGET}\n`);
  });
});

describe("runs list", () => {
  const body = {
    runs: [summary(runId(1), "RUNNING"), summary(runId(2), "WAITING_APPROVAL")],
    total: 2, limit: 50, offset: 0,
  };

  it("filters by public status case-insensitively", async () => {
    await serve(() => ({ status: 200, body }));
    const fake = await authedIO(api!.url);
    expect(await run(["runs", "list", "--status", "waiting_approval"], fake.io)).toBe(0);
    expect(fake.stdout()).toContain(runId(2).slice(0, 8));
    expect(fake.stdout()).not.toContain(runId(1).slice(0, 8));
    expect(fake.stdout()).toContain("release-flow@v1");
  });

  it("prints ids with -q", async () => {
    await serve(() => ({ status: 200, body }));
    const fake = await authedIO(api!.url);
    expect(await run(["runs", "list", "-q"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe(`${runId(1)}\n${runId(2)}\n`);
  });
});

describe("runs show", () => {
  it("resolves a prefix and renders steps", async () => {
    await serve((request) => (request.path === "/runs"
      ? pagedRuns(1, [TARGET])(request)
      : { status: 200, body: detail(TARGET, "WAITING_APPROVAL") }));
    const fake = await authedIO(api!.url);
    expect(await run(["runs", "show", "deadbeef"], fake.io)).toBe(0);
    expect(fake.stdout()).toContain("search-aws");
    expect(fake.stdout()).toContain("approve-publication");
    expect(fake.stdout()).toContain("2/3");
    expect(fake.stdout()).toContain("WAITING_APPROVAL");
  });

  it("prints the raw body with --json", async () => {
    await serve(() => ({ status: 200, body: detail(TARGET) }));
    const fake = await authedIO(api!.url);
    expect(await run(["runs", "show", TARGET, "--json"], fake.io)).toBe(0);
    expect(JSON.parse(fake.stdout())).toEqual(detail(TARGET));
  });
});

describe("run sub-resources", () => {
  it("renders history events", async () => {
    await serve(() => ({
      status: 200,
      body: { events: [{ id: "e1", sequence: 1, stepId: null, attemptId: null, type: "RUN_CREATED", payload: {}, createdAt: "2026-10-08T11:59:00.000Z" }] },
    }));
    const fake = await authedIO(api!.url);
    expect(await run(["runs", "history", TARGET], fake.io)).toBe(0);
    expect(api!.requests[0]?.path).toBe(`/runs/${TARGET}/history`);
    expect(fake.stdout()).toContain("RUN_CREATED");
  });

  it.each([
    ["attempts", "attempts", { attempts: [] }],
    ["usage", "usage", { usage: [] }],
    ["sources", "sources", { sources: [] }],
    ["tools", "tool-executions", { executions: [] }],
    ["ops", "harness-operations", { operations: [] }],
  ])("runs %s calls /runs/:id/%s", async (command, resource, body) => {
    await serve(() => ({ status: 200, body }));
    const fake = await authedIO(api!.url);
    expect(await run(["runs", command, TARGET], fake.io)).toBe(0);
    expect(api!.requests[0]?.path).toBe(`/runs/${TARGET}/${resource}`);
  });
});

describe("run control", () => {
  it("refuses to cancel without --yes when not interactive", async () => {
    await serve(() => ({ status: 200, body: detail(TARGET, "CANCELLED") }));
    const fake = await authedIO(api!.url);
    expect(await run(["runs", "cancel", TARGET], fake.io)).toBe(2);
    expect(api!.requests).toEqual([]);
  });

  it("cancels with --yes", async () => {
    await serve(() => ({ status: 200, body: detail(TARGET, "CANCEL_REQUESTED") }));
    const fake = await authedIO(api!.url);
    expect(await run(["runs", "cancel", TARGET, "--yes"], fake.io)).toBe(0);
    expect(api!.requests[0]).toMatchObject({ method: "POST", path: `/runs/${TARGET}/cancel` });
    expect(fake.stdout()).toContain("CANCEL_REQUESTED");
  });

  it("maps a conflict on pause to exit 5", async () => {
    await serve(() => ({ status: 409, body: { error: "CONFLICT", message: "run is already terminal" } }));
    const fake = await authedIO(api!.url);
    expect(await run(["runs", "pause", TARGET], fake.io)).toBe(5);
    expect(fake.stderr()).toContain("run is already terminal");
  });
});
