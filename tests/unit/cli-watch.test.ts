import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../apps/cli/src/run.js";
import { authedIO, startFakeApi, type FakeApi, type FakeIOOptions, type FakeResponse, type RecordedRequest } from "./cli-helpers.js";

const RUN = "deadbeef-1234-4000-8000-000000000001";
const VERSION_ID = "cccccccc-0000-4000-8000-000000000003";

let api: FakeApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

function detail(publicStatus: string) {
  return {
    id: RUN, workflowVersionId: VERSION_ID, lifecycle: "OPEN", publicStatus,
    createdAt: "2026-10-08T11:59:00.000Z", finishedAt: null, deadlineAt: "2026-10-08T12:05:00.000Z", failure: null,
    steps: [{ id: "s1", nodeKey: "review", position: 0, kind: "APPROVAL", status: "RUNNING",
      attemptCount: 0, maxAttempts: 3, createdAt: "2026-10-08T11:59:00.000Z", completedAt: null }],
  };
}

const event = (n: number, type: string) => ({
  id: `e${n}`, sequence: n, stepId: n > 1 ? "s1" : null, attemptId: null, type, payload: {}, createdAt: `2026-10-08T11:59:0${n}.000Z`,
});

/** Serves `statuses` in order for GET /runs/:id (a number means respond with that HTTP status). */
async function serveSequence(statuses: Array<string | number>, history = [event(1, "RUN_CREATED")]) {
  let index = 0;
  const handler = (request: RecordedRequest): FakeResponse => {
    if (request.method === "POST" && request.path === "/runs") return { status: 201, body: detail("QUEUED") };
    if (request.path.endsWith("/history")) return { status: 200, body: { events: history } };
    const next = statuses[Math.min(index++, statuses.length - 1)]!;
    return typeof next === "number" ? { status: next, body: { error: "BOOM" } } : { status: 200, body: detail(next) };
  };
  api = await startFakeApi(handler);
  return api;
}

async function watch(args: string[], options: FakeIOOptions = {}) {
  const fake = await authedIO(api!.url, options);
  const code = await run(["runs", "watch", RUN, ...args], fake.io);
  return { code, fake };
}

describe("runs watch stop conditions", () => {
  it("exits 0 when the run succeeds", async () => {
    await serveSequence(["QUEUED", "RUNNING", "SUCCEEDED"]);
    const { code, fake } = await watch([]);
    expect(code).toBe(0);
    expect(fake.stdout().trimEnd().split("\n").at(-1)).toMatch(/SUCCEEDED$/);
  });

  it("stops at WAITING_APPROVAL with exit 12", async () => {
    await serveSequence(["RUNNING", "WAITING_APPROVAL"]);
    expect((await watch([])).code).toBe(12);
  });

  it("keeps going past WAITING with --until-terminal", async () => {
    await serveSequence(["RUNNING", "WAITING_APPROVAL", "SUCCEEDED"]);
    expect((await watch(["--until-terminal"])).code).toBe(0);
  });

  it.each([
    ["NEEDS_ATTENTION", 12],
    ["FAILED", 10],
    ["CANCELLED", 11],
    ["TIMED_OUT", 14],
  ])("maps %s to exit %i", async (status, expected) => {
    await serveSequence([status]);
    expect((await watch([])).code).toBe(expected);
  });

  it("keeps watching through PAUSED", async () => {
    await serveSequence(["PAUSED", "RUNNING", "SUCCEEDED"]);
    expect((await watch([])).code).toBe(0);
  });
});

describe("runs watch resilience", () => {
  it("backs off on server errors and resets after success", async () => {
    await serveSequence([500, 500, "RUNNING", "SUCCEEDED"]);
    const { code, fake } = await watch(["--interval", "2s"]);
    expect(code).toBe(0);
    expect(fake.stderr()).toContain("Retrying");
    expect(fake.sleeps).toEqual([4_000, 8_000, 2_000]);
  });

  it("caps backoff at 30 seconds", async () => {
    await serveSequence([...Array<number>(10).fill(503), "SUCCEEDED"]);
    const { code, fake } = await watch(["--interval", "2s"]);
    expect(code).toBe(0);
    expect(Math.max(...fake.sleeps)).toBe(30_000);
  });

  it("honours --timeout while the API keeps failing", async () => {
    await serveSequence([503]);
    let now = Date.parse("2026-10-08T12:00:00.000Z");
    const { code, fake } = await watch(["--timeout", "5s", "--interval", "2s"], {
      now: () => now,
      onSleep: (ms) => { now += ms; },
    });
    expect(code).toBe(13);
    expect(fake.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(5_000);
  });

  it("aborts immediately on 404", async () => {
    await serveSequence(["RUNNING", 404]);
    expect((await watch([])).code).toBe(4);
  });

  it("gives up after --timeout with exit 13", async () => {
    await serveSequence(["RUNNING"]);
    let now = Date.parse("2026-10-08T12:00:00.000Z");
    const { code } = await watch(["--timeout", "5s", "--interval", "2s"], {
      now: () => now,
      onSleep: (ms) => { now += ms; },
    });
    expect(code).toBe(13);
  });

  it("traps Ctrl-C only while watching", async () => {
    await serveSequence(["RUNNING", "SUCCEEDED"]);
    const during: number[] = [];
    const fake = await authedIO(api!.url, { onSleep: () => { during.push(fake.trapped()); } });
    expect(await run(["runs", "watch", RUN], fake.io)).toBe(0);
    expect(during).toEqual([1]);
    expect(fake.trapped()).toBe(0);
  });

  it("stops on Ctrl-C without touching the run", async () => {
    await serveSequence(["RUNNING"]);
    const fake = await authedIO(api!.url, { onSleep: () => { fake.abort(); } });
    const code = await run(["runs", "watch", RUN], fake.io);
    expect(code).toBe(130);
    expect(fake.stderr()).toContain(`run ${RUN} is unaffected`);
    expect(api!.requests.every((r) => r.method === "GET")).toBe(true);
  });
});

describe("runs watch rendering", () => {
  it("redraws in place on a TTY", async () => {
    await serveSequence(["RUNNING", "SUCCEEDED"]);
    const { fake } = await watch([], { stdoutTTY: true });
    expect(fake.stdout()).toMatch(/\x1b\[\d+A/);
  });

  it("appends plain lines when piped, printing each event once", async () => {
    await serveSequence(["RUNNING", "RUNNING", "SUCCEEDED"], [event(1, "RUN_CREATED"), event(2, "STEP_STARTED")]);
    const { fake } = await watch([]);
    const out = fake.stdout();
    expect(out).not.toContain("\x1b[");
    expect(out.match(/RUN_CREATED/g)).toHaveLength(1);
    expect(out.match(/STEP_STARTED/g)).toHaveLength(1);
    expect(out).toMatch(/STEP_STARTED\s+review/);
  });

  it("prints only the final run body with --json", async () => {
    await serveSequence(["RUNNING", "SUCCEEDED"]);
    const { code, fake } = await watch(["--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(fake.stdout())).toMatchObject({ id: RUN, publicStatus: "SUCCEEDED" });
  });
});

describe("runs start --watch", () => {
  it("starts then watches, returning the watch exit code", async () => {
    await serveSequence(["WAITING_APPROVAL"]);
    const fake = await authedIO(api!.url);
    const code = await run(["runs", "start", VERSION_ID, "--watch"], fake.io);
    expect(code).toBe(12);
    expect(api!.requests[0]).toMatchObject({ method: "POST", path: "/runs" });
  });

  it("prints only the final body with --json", async () => {
    await serveSequence(["SUCCEEDED"]);
    const fake = await authedIO(api!.url);
    expect(await run(["runs", "start", VERSION_ID, "--watch", "--json"], fake.io)).toBe(0);
    expect(JSON.parse(fake.stdout())).toMatchObject({ publicStatus: "SUCCEEDED" });
  });
});
