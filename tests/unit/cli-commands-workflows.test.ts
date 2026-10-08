import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../apps/cli/src/run.js";
import { authedIO, startFakeApi, type FakeApi, type FakeResponse, type RecordedRequest } from "./cli-helpers.js";

const WF = "aaaaaaaa-0000-4000-8000-000000000001";
const WF2 = "bbbbbbbb-0000-4000-8000-000000000002";
const VER = "cccccccc-0000-4000-8000-000000000003";

let api: FakeApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

async function serve(handler: (request: RecordedRequest) => FakeResponse) {
  api = await startFakeApi(handler);
  return api;
}

const workflowList = {
  workflows: [
    { id: WF, name: "release-flow", description: "", createdAt: "2026-10-08T11:00:00.000Z", latestVersion: 2, versionCount: 2 },
    { id: WF2, name: "empty-flow", description: "", createdAt: "2026-10-08T11:30:00.000Z", latestVersion: null, versionCount: 0 },
  ],
};

describe("workflows list", () => {
  it("renders a table with (none) for unpublished workflows", async () => {
    await serve(() => ({ status: 200, body: workflowList }));
    const fake = await authedIO(api!.url);
    expect(await run(["workflows", "list"], fake.io)).toBe(0);
    expect(fake.stdout()).toContain("release-flow");
    expect(fake.stdout()).toMatch(/empty-flow\s+\(none\)/);
    expect(fake.stdout()).toContain("1h ago");
  });

  it("prints only ids with -q", async () => {
    await serve(() => ({ status: 200, body: workflowList }));
    const fake = await authedIO(api!.url);
    expect(await run(["workflows", "list", "-q"], fake.io)).toBe(0);
    expect(fake.stdout()).toBe(`${WF}\n${WF2}\n`);
  });

  it("prints the raw body with --json", async () => {
    await serve(() => ({ status: 200, body: workflowList }));
    const fake = await authedIO(api!.url);
    expect(await run(["--json", "workflows", "list"], fake.io)).toBe(0);
    expect(JSON.parse(fake.stdout())).toEqual(workflowList);
  });
});

describe("workflows show", () => {
  it("renders versions", async () => {
    await serve(() => ({
      status: 200,
      body: {
        id: WF, name: "release-flow", description: "d", createdAt: "2026-10-08T11:00:00.000Z",
        versions: [{ id: VER, version: 1, createdAt: "2026-10-08T11:00:00.000Z", stepCount: 2 }],
      },
    }));
    const fake = await authedIO(api!.url);
    expect(await run(["workflows", "show", WF], fake.io)).toBe(0);
    expect(fake.stdout()).toMatch(/name\s+release-flow/);
    expect(fake.stdout()).toContain(VER);
  });

  it("exits 4 for an unknown workflow", async () => {
    await serve(() => ({ status: 404, body: { error: "NOT_FOUND" } }));
    const fake = await authedIO(api!.url);
    expect(await run(["workflows", "show", WF], fake.io)).toBe(4);
    expect(fake.stderr()).toContain(`Workflow ${WF} not found`);
  });
});

describe("workflows create", () => {
  it("rejects an empty name client-side", async () => {
    await serve(() => ({ status: 201, body: { id: WF, name: "x" } }));
    const fake = await authedIO(api!.url);
    expect(await run(["workflows", "create", "--name", ""], fake.io)).toBe(2);
    expect(api!.requests).toEqual([]);
  });

  it("creates and prints the id with -q", async () => {
    await serve(() => ({ status: 201, body: { id: WF, name: "x", description: "" } }));
    const fake = await authedIO(api!.url);
    expect(await run(["workflows", "create", "--name", "x", "-q"], fake.io)).toBe(0);
    expect(api!.requests[0]?.body).toEqual({ name: "x", description: "" });
    expect(fake.stdout()).toBe(`${WF}\n`);
  });
});

describe("workflows publish", () => {
  const definition = { steps: [{ key: "finalize", kind: "DETERMINISTIC", handler: "finalize" }] };
  const created = { id: VER, workflowId: WF, version: 1 };

  it("sends the definition from a file", async () => {
    await serve(() => ({ status: 201, body: created }));
    const fake = await authedIO(api!.url);
    const file = join(fake.dir, "def.json");
    await writeFile(file, JSON.stringify(definition));
    expect(await run(["workflows", "publish", WF, "--version", "1", "--definition", file], fake.io)).toBe(0);
    expect(api!.requests[0]).toMatchObject({ method: "POST", path: `/workflows/${WF}/versions` });
    expect(api!.requests[0]?.body).toMatchObject({ version: 1, definition });
    expect(fake.stdout()).toContain(VER);
  });

  it("reads the definition from stdin with -", async () => {
    await serve(() => ({ status: 201, body: created }));
    const fake = await authedIO(api!.url);
    fake.feed(JSON.stringify(definition));
    fake.endInput();
    expect(await run(["workflows", "publish", WF, "--version", "1", "--definition", "-"], fake.io)).toBe(0);
    expect(api!.requests[0]?.body).toMatchObject({ definition });
  });

  it("exits 2 naming a malformed definition file", async () => {
    await serve(() => ({ status: 201, body: created }));
    const fake = await authedIO(api!.url);
    const file = join(fake.dir, "broken.json");
    await writeFile(file, "{nope");
    expect(await run(["workflows", "publish", WF, "--version", "1", "--definition", file], fake.io)).toBe(2);
    expect(fake.stderr()).toContain("broken.json");
    expect(api!.requests).toEqual([]);
  });

  it("rejects a non-integer version", async () => {
    await serve(() => ({ status: 201, body: created }));
    const fake = await authedIO(api!.url);
    expect(await run(["workflows", "publish", WF, "--version", "one"], fake.io)).toBe(2);
    expect(api!.requests).toEqual([]);
  });
});

describe("workflows reference", () => {
  const setup = {
    workflowId: WF, workflowVersionId: VER, workflowName: "cloud-comparison-scripted", version: 1,
    created: true, mode: "scripted", provider: "scripted-research", model: "x", definition: { steps: [] },
  };

  it("converts --approval-expires and defaults to scripted mode", async () => {
    await serve(() => ({ status: 201, body: setup }));
    const fake = await authedIO(api!.url);
    expect(await run(["workflows", "reference", "--approval-expires", "2h"], fake.io)).toBe(0);
    expect(api!.requests[0]?.body).toEqual({ mode: "scripted", approvalExpiresAfterMs: 7_200_000 });
    expect(fake.stdout()).toContain(VER);
  });

  it("maps a server validation error to exit 2", async () => {
    await serve(() => ({
      status: 400,
      body: { error: "VALIDATION_ERROR", details: [{ path: ["provider"], message: "live mode requires provider and model" }] },
    }));
    const fake = await authedIO(api!.url);
    expect(await run(["workflows", "reference", "--mode", "live"], fake.io)).toBe(2);
    expect(fake.stderr()).toContain("provider: live mode requires provider and model");
  });
});
