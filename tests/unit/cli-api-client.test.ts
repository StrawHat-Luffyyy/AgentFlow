import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "../../apps/cli/src/api-client.js";
import type { StoredAuth } from "../../apps/cli/src/config-store.js";
import { ApiError, CliError } from "../../apps/cli/src/errors.js";
import { Output } from "../../apps/cli/src/output/emit.js";
import { fakeIO, startFakeApi, type FakeApi, type FakeResponse } from "./cli-helpers.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-10-08T12:00:00.000Z");

let api: FakeApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

async function client(response: FakeResponse, auth?: StoredAuth, verbose = false) {
  api = await startFakeApi(() => response);
  const fake = fakeIO();
  const out = new Output(fake.io, { json: false, quiet: false, color: false, verbose });
  return { fake, client: new ApiClient({ baseUrl: api.url, io: fake.io, out, ...(auth ? { auth } : {}) }) };
}

async function failure(promise: Promise<unknown>): Promise<CliError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(CliError);
  return error as CliError;
}

const session: StoredAuth = { type: "session", sessionId: "s1d", username: "alice", expiresAt: "2026-10-15T00:00:00.000Z" };
const token: StoredAuth = { type: "token", token: "t0k3n" };

describe("ApiClient authentication headers", () => {
  it("sends a bearer token", async () => {
    const { client: c } = await client({ status: 200, body: { id: "u1", roles: [] } }, token);
    await c.me();
    expect(api!.requests[0]?.headers.authorization).toBe("Bearer t0k3n");
  });

  it("sends the session cookie", async () => {
    const { client: c } = await client({ status: 200, body: { id: "u1", roles: [] } }, session);
    await c.me();
    expect(api!.requests[0]?.headers.cookie).toBe("agentflow_session=s1d");
  });
});

describe("ApiClient error mapping", () => {
  it("maps 401 on a session to an expired-session auth error", async () => {
    const { client: c } = await client({ status: 401, body: { error: "UNAUTHENTICATED" } }, session);
    const error = await failure(c.me());
    expect(error.exitCode).toBe(3);
    expect(error.message).toContain("expired");
    expect(error.message).toContain("agentflow login");
  });

  it("maps 401 on a token to not-logged-in", async () => {
    const { client: c } = await client({ status: 401, body: { error: "UNAUTHENTICATED" } }, token);
    const error = await failure(c.me());
    expect(error.exitCode).toBe(3);
    expect(error.message).toContain("Not logged in");
  });

  it("names the required role on 403", async () => {
    const { client: c } = await client({ status: 403, body: { error: "FORBIDDEN" } }, token);
    const error = await failure(c.reconcile(RUN_ID, { resolution: "FAIL_FINAL" }));
    expect(error.exitCode).toBe(3);
    expect(error.message).toContain("operator");
  });

  it("maps 404 with the resource name", async () => {
    const { client: c } = await client({ status: 404, body: { error: "NOT_FOUND" } }, token);
    const error = await failure(c.getRun(RUN_ID));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.exitCode).toBe(4);
    expect(error.message).toBe(`Run ${RUN_ID} not found (or not owned by you)`);
  });

  it("maps 409 to the server message", async () => {
    const { client: c } = await client({ status: 409, body: { error: "CONFLICT", message: "run already finished" } }, token);
    const error = await failure(c.controlRun(RUN_ID, "cancel"));
    expect(error.exitCode).toBe(5);
    expect(error.message).toBe("run already finished");
  });

  it("formats validation issues on 400", async () => {
    const { client: c } = await client({
      status: 400,
      body: { error: "VALIDATION_ERROR", details: [{ path: ["input"], message: "Required" }] },
    }, token);
    const error = await failure(c.createRun({ workflowVersionId: RUN_ID, input: {} }));
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain("input: Required");
  });

  it("maps 5xx to a server error", async () => {
    const { client: c } = await client({ status: 500, body: { error: "INTERNAL_ERROR" } }, token);
    const error = await failure(c.me());
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("Server error (500)");
  });

  it("reports an unreachable API with its URL", async () => {
    const fake = fakeIO();
    const out = new Output(fake.io, { json: false, quiet: false, color: false, verbose: false });
    const c = new ApiClient({ baseUrl: "http://127.0.0.1:9", io: fake.io, out, auth: token });
    const error = await failure(c.me());
    expect(error.code).toBe("NETWORK");
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("http://127.0.0.1:9");
  });

  it("rejects unexpected response shapes", async () => {
    const { client: c } = await client({ status: 200, body: { unexpected: true } }, token);
    const error = await failure(c.getRun(RUN_ID));
    expect(error.code).toBe("BAD_RESPONSE");
    expect(error.exitCode).toBe(1);
  });
});

describe("ApiClient.login", () => {
  it("extracts the session cookie and its expiry", async () => {
    api = await startFakeApi(() => ({
      status: 200,
      body: { user: { id: "u1", username: "admin", roles: ["operator"] } },
      headers: { "set-cookie": "agentflow_session=abc; Max-Age=604800; Path=/; HttpOnly" },
    }));
    const fake = fakeIO({ now: () => NOW });
    const out = new Output(fake.io, { json: false, quiet: false, color: false, verbose: false });
    const c = new ApiClient({ baseUrl: api.url, io: fake.io, out });
    const result = await c.login("admin", "pw");
    expect(result.sessionId).toBe("abc");
    expect(result.expiresAt).toBe(new Date(NOW + 604_800_000).toISOString());
    expect(result.user.username).toBe("admin");
    expect(api.requests[0]?.body).toEqual({ username: "admin", password: "pw" });
  });
});

describe("ApiClient verbose logging", () => {
  it("logs requests without leaking the token", async () => {
    const { client: c, fake } = await client({ status: 200, body: { id: "u1", roles: [] } }, token, true);
    await c.me();
    expect(fake.stderr()).toContain("→ GET /me");
    expect(fake.stderr()).toContain("Bearer ***");
    expect(fake.stderr()).not.toContain("t0k3n");
  });
});
