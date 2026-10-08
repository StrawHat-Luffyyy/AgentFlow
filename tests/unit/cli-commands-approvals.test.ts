import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@agentflow/shared";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../apps/cli/src/run.js";
import { authedIO, startFakeApi, type FakeApi, type FakeResponse, type RecordedRequest } from "./cli-helpers.js";

const APPROVAL = "aaaaaaaa-1111-4000-8000-000000000001";
const RUN = "deadbeef-1234-4000-8000-000000000001";
const TOOL = "eeeeeeee-2222-4000-8000-000000000002";
const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

let api: FakeApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

function approval(overrides: Record<string, unknown> = {}) {
  const payload = { report: "cloud comparison", target: "controlled://publications/main" };
  const proposal = { stepKey: "approve-publication", payload };
  return {
    id: APPROVAL, runId: RUN, stepId: "s1", generation: 1, status: "PENDING",
    proposal, proposalHash: sha(proposal), payload, payloadHash: sha(payload),
    reviewerRole: "research-reviewer", expiresAt: "2026-10-09T12:00:00.000Z",
    decision: null, decisionAt: null, decidedBy: null, decidedRole: null, decisionRequestId: null,
    createdAt: "2026-10-08T11:00:00.000Z",
    ...overrides,
  };
}

async function serve(handler: (request: RecordedRequest) => FakeResponse) {
  api = await startFakeApi(handler);
  return api;
}

function approvalsApi(list: unknown[], decision: FakeResponse = { status: 200, body: { kind: "accepted", runId: RUN } }) {
  return (request: RecordedRequest): FakeResponse => {
    if (request.method === "GET" && request.path === "/approvals") return { status: 200, body: { approvals: list } };
    if (request.method === "GET" && request.path === "/runs") {
      return { status: 200, body: { runs: [{
        id: RUN, workflowVersionId: RUN, workflowName: "w", workflowVersion: 1, publicStatus: "WAITING_APPROVAL",
        createdAt: "2026-10-08T11:00:00.000Z", stepCount: 1, completedStepCount: 0, inputTokens: 0, outputTokens: 0,
      }], total: 1, limit: 100, offset: 0 } };
    }
    return decision;
  };
}

const posts = () => api!.requests.filter((r) => r.method === "POST");

describe("approvals approve/reject", () => {
  it("approves with the server hashes and a fresh decision request id", async () => {
    await serve(approvalsApi([approval()]));
    const first = await authedIO(api!.url);
    expect(await run(["approvals", "approve", APPROVAL, "--yes"], first.io)).toBe(0);
    const second = await authedIO(api!.url);
    expect(await run(["approvals", "approve", APPROVAL, "--yes"], second.io)).toBe(0);
    const [a, b] = posts();
    expect(a).toMatchObject({ path: `/approvals/${APPROVAL}/decisions` });
    expect(a?.body).toMatchObject({ decision: "APPROVE", proposalHash: approval().proposalHash, payloadHash: approval().payloadHash });
    const ids = [a, b].map((r) => (r?.body as { decisionRequestId: string }).decisionRequestId);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(first.stdout()).toContain(`Approved approval ${APPROVAL}`);
  });

  it("accepts the short id printed by approvals list", async () => {
    await serve(approvalsApi([approval()]));
    const fake = await authedIO(api!.url);
    expect(await run(["approvals", "approve", APPROVAL.slice(0, 8), "--yes"], fake.io)).toBe(0);
    expect(posts()[0]?.path).toBe(`/approvals/${APPROVAL}/decisions`);
  });

  it("refuses an ambiguous approval prefix", async () => {
    const twin = "aaaaaaaa-9999-4000-8000-000000000009";
    await serve(approvalsApi([approval(), approval({ id: twin })]));
    const fake = await authedIO(api!.url);
    expect(await run(["approvals", "approve", "aaaaaaaa", "--yes"], fake.io)).toBe(2);
    expect(fake.stderr()).toContain(twin);
    expect(posts()).toEqual([]);
  });

  it("rejects with decision REJECT", async () => {
    await serve(approvalsApi([approval()]));
    const fake = await authedIO(api!.url);
    expect(await run(["approvals", "reject", APPROVAL, "--yes"], fake.io)).toBe(0);
    expect(posts()[0]?.body).toMatchObject({ decision: "REJECT" });
  });

  it("refuses to sign content that does not match its hashes", async () => {
    await serve(approvalsApi([approval({ payload: { report: "tampered" } })]));
    const fake = await authedIO(api!.url);
    expect(await run(["approvals", "approve", APPROVAL, "--yes"], fake.io)).toBe(1);
    expect(fake.stderr()).toContain("refusing to sign");
    expect(posts()).toEqual([]);
  });

  it("refuses without --yes when not interactive", async () => {
    await serve(approvalsApi([approval()]));
    const fake = await authedIO(api!.url);
    expect(await run(["approvals", "approve", APPROVAL], fake.io)).toBe(2);
    expect(posts()).toEqual([]);
  });

  it("exits 4 when the approval is not pending for the caller", async () => {
    await serve(approvalsApi([]));
    const fake = await authedIO(api!.url);
    expect(await run(["approvals", "approve", APPROVAL, "--yes"], fake.io)).toBe(4);
  });

  it("names the reviewer role on 403", async () => {
    await serve(approvalsApi([approval()], { status: 403, body: { error: "FORBIDDEN" } }));
    const fake = await authedIO(api!.url);
    expect(await run(["approvals", "approve", APPROVAL, "--yes"], fake.io)).toBe(3);
    expect(fake.stderr()).toContain("research-reviewer");
  });
});

describe("approvals list/show", () => {
  it("filters by a resolved run prefix", async () => {
    await serve(approvalsApi([approval()]));
    const fake = await authedIO(api!.url);
    expect(await run(["approvals", "list", "--run", "deadbeef"], fake.io)).toBe(0);
    const listCall = api!.requests.find((r) => r.path === "/approvals");
    expect(listCall?.query).toEqual({ runId: RUN });
    expect(fake.stdout()).toContain("approve-publication");
    expect(fake.stdout()).toContain("research-reviewer");
  });

  it("shows proposal, payload and hashes", async () => {
    await serve(approvalsApi([approval()]));
    const fake = await authedIO(api!.url);
    expect(await run(["approvals", "show", APPROVAL], fake.io)).toBe(0);
    expect(fake.stdout()).toContain("cloud comparison");
    expect(fake.stdout()).toContain(approval().payloadHash);
  });
});

describe("tools reconcile", () => {
  const reconciled: FakeResponse = { status: 200, body: { id: RUN } };

  it("fails a tool execution with --fail --yes", async () => {
    await serve(() => reconciled);
    const fake = await authedIO(api!.url);
    expect(await run(["tools", "reconcile", TOOL, "--fail", "--yes"], fake.io)).toBe(0);
    expect(posts()[0]).toMatchObject({ path: `/tool-executions/${TOOL}/reconcile`, body: { resolution: "FAIL_FINAL" } });
  });

  it("confirms success with a receiver and receipt file", async () => {
    await serve(() => reconciled);
    const fake = await authedIO(api!.url);
    const file = join(fake.dir, "receipt.json");
    await writeFile(file, JSON.stringify({ publicationId: "p1" }));
    const code = await run(["tools", "reconcile", TOOL, "--succeeded", "--receiver", "r1", "--receipt", file, "--yes"], fake.io);
    expect(code).toBe(0);
    expect(posts()[0]?.body).toEqual({ resolution: "CONFIRM_SUCCEEDED", receiverId: "r1", receipt: { publicationId: "p1" } });
  });

  it("requires --receipt with --succeeded", async () => {
    await serve(() => reconciled);
    const fake = await authedIO(api!.url);
    expect(await run(["tools", "reconcile", TOOL, "--succeeded", "--receiver", "r1", "--yes"], fake.io)).toBe(2);
    expect(api!.requests).toEqual([]);
  });

  it("requires exactly one of --succeeded and --fail", async () => {
    await serve(() => reconciled);
    expect(await run(["tools", "reconcile", TOOL, "--succeeded", "--fail", "--yes"], (await authedIO(api!.url)).io)).toBe(2);
    expect(await run(["tools", "reconcile", TOOL, "--yes"], (await authedIO(api!.url)).io)).toBe(2);
    expect(api!.requests).toEqual([]);
  });

  it("names the operator role on 403", async () => {
    await serve(() => ({ status: 403, body: { error: "FORBIDDEN" } }));
    const fake = await authedIO(api!.url);
    expect(await run(["tools", "reconcile", TOOL, "--fail", "--yes"], fake.io)).toBe(3);
    expect(fake.stderr()).toContain("operator");
  });
});
