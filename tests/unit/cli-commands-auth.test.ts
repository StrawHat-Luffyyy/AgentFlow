import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../apps/cli/src/run.js";
import { fakeIO, startFakeApi, type FakeApi, type FakeIOOptions, type RecordedRequest, type FakeResponse } from "./cli-helpers.js";

let dir: string;
let configFile: string;
let api: FakeApi | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentflow-cli-auth-"));
  configFile = join(dir, "config.json");
});
afterEach(async () => {
  await api?.close();
  api = undefined;
});

async function serve(handler: (request: RecordedRequest) => FakeResponse) {
  api = await startFakeApi(handler);
  return api;
}

function cli(options: FakeIOOptions = {}) {
  return fakeIO({ ...options, env: { AGENTFLOW_CONFIG: configFile, ...options.env } });
}

async function readConfig() {
  return JSON.parse(await readFile(configFile, "utf8")) as {
    currentProfile: string;
    profiles: Record<string, { url?: string; auth?: Record<string, string> }>;
  };
}

async function writeConfig(config: unknown) {
  await writeFile(configFile, JSON.stringify(config));
}

describe("login --token", () => {
  it("reads the token from piped stdin, verifies it, and stores it", async () => {
    await serve(() => ({ status: 200, body: { id: "u1", roles: ["operator"] } }));
    const fake = cli();
    fake.feed("t0k3n\n");
    const code = await run(["login", "--token", "--url", api!.url], fake.io);
    expect(code).toBe(0);
    expect(api!.requests[0]?.headers.authorization).toBe("Bearer t0k3n");
    const config = await readConfig();
    expect(config.profiles.default).toEqual({ url: api!.url, auth: { type: "token", token: "t0k3n" } });
    expect(fake.stdout() + fake.stderr()).not.toContain("t0k3n");
  });

  it("says it is reading the token from stdin when not on a TTY", async () => {
    await serve(() => ({ status: 200, body: { id: "u1", roles: [] } }));
    const fake = cli();
    fake.feed("t0k3n\n");
    expect(await run(["login", "--token", "--url", api!.url], fake.io)).toBe(0);
    expect(fake.stderr()).toContain("Reading API token from stdin");
  });

  it("does not save a token the API rejects", async () => {
    await serve(() => ({ status: 401, body: { error: "UNAUTHENTICATED" } }));
    const fake = cli();
    fake.feed("bad\n");
    expect(await run(["login", "--token", "--url", api!.url], fake.io)).toBe(3);
    expect(existsSync(configFile)).toBe(false);
  });
});

describe("login with a password", () => {
  it("refuses without a terminal and makes no request", async () => {
    await serve(() => ({ status: 500 }));
    const fake = cli();
    expect(await run(["login", "--url", api!.url], fake.io)).toBe(2);
    expect(api!.requests).toEqual([]);
  });

  it("stores the session from the login cookie", async () => {
    await serve(() => ({
      status: 200,
      body: { user: { id: "u1", username: "admin", roles: [] } },
      headers: { "set-cookie": "agentflow_session=sess1; Max-Age=604800; Path=/; HttpOnly" },
    }));
    const fake = cli({ stdinTTY: true });
    const pending = run(["login", "--username", "admin", "--url", api!.url], fake.io);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.feed("pw\r");
    expect(await pending).toBe(0);
    expect(api!.requests[0]?.body).toEqual({ username: "admin", password: "pw" });
    const auth = (await readConfig()).profiles.default?.auth;
    expect(auth).toMatchObject({ type: "session", sessionId: "sess1", username: "admin" });
    expect(fake.stdout() + fake.stderr()).not.toContain("sess1");
  });
});

describe("logout", () => {
  it("ends the server session and clears stored auth", async () => {
    await serve(() => ({ status: 200, body: { status: "ok" } }));
    await writeConfig({
      currentProfile: "default",
      profiles: { default: { url: api!.url, auth: { type: "session", sessionId: "sid", username: "a", expiresAt: "2026-10-15T00:00:00.000Z" } } },
    });
    const fake = cli();
    expect(await run(["logout"], fake.io)).toBe(0);
    expect(api!.requests[0]).toMatchObject({ method: "POST", path: "/auth/logout" });
    expect(api!.requests[0]?.headers.cookie).toBe("agentflow_session=sid");
    expect((await readConfig()).profiles.default).toEqual({ url: api!.url });
  });

  it("still clears auth when the API is unreachable", async () => {
    await writeConfig({
      currentProfile: "default",
      profiles: { default: { url: "http://127.0.0.1:9", auth: { type: "session", sessionId: "sid", username: "a", expiresAt: "x" } } },
    });
    const fake = cli();
    expect(await run(["logout"], fake.io)).toBe(0);
    expect(fake.stderr()).toContain("Could not");
    expect((await readConfig()).profiles.default?.auth).toBeUndefined();
  });
});

describe("whoami", () => {
  it("prints the /me body with --json", async () => {
    await serve(() => ({ status: 200, body: { id: "u1", roles: ["operator"], username: "admin" } }));
    const fake = cli({ env: { AGENTFLOW_TOKEN: "x", AGENTFLOW_URL: api!.url } });
    expect(await run(["whoami", "--json"], fake.io)).toBe(0);
    expect(JSON.parse(fake.stdout())).toEqual({ id: "u1", roles: ["operator"], username: "admin" });
  });

  it("renders identity, roles and auth source", async () => {
    await serve(() => ({ status: 200, body: { id: "u1", roles: [] } }));
    const fake = cli({ env: { AGENTFLOW_TOKEN: "x", AGENTFLOW_URL: api!.url } });
    expect(await run(["whoami"], fake.io)).toBe(0);
    expect(fake.stdout()).toMatch(/id\s+u1/);
    expect(fake.stdout()).toMatch(/roles\s+\(none\)/);
    expect(fake.stdout()).toMatch(/auth\s+env token/);
  });

  it("exits 3 without contacting the API when not logged in", async () => {
    await serve(() => ({ status: 200, body: { id: "u1", roles: [] } }));
    const fake = cli({ env: { AGENTFLOW_URL: api!.url } });
    expect(await run(["whoami"], fake.io)).toBe(3);
    expect(api!.requests).toEqual([]);
  });
});

describe("config", () => {
  it("list masks secrets", async () => {
    await writeConfig({ currentProfile: "default", profiles: { default: { url: "http://a", auth: { type: "token", token: "secret-tok" } } } });
    const fake = cli();
    expect(await run(["config", "list"], fake.io)).toBe(0);
    expect(fake.stdout()).toContain("***");
    expect(fake.stdout()).not.toContain("secret-tok");
  });

  it("set url persists to the selected profile", async () => {
    const fake = cli();
    expect(await run(["config", "set", "url", "http://x:1"], fake.io)).toBe(0);
    expect((await readConfig()).profiles.default?.url).toBe("http://x:1");
    const get = cli();
    expect(await run(["config", "get", "url"], get.io)).toBe(0);
    expect(get.stdout().trim()).toBe("http://x:1");
  });

  it("refuses to set secret or unknown keys", async () => {
    expect(await run(["config", "set", "token", "x"], cli().io)).toBe(2);
    expect(await run(["config", "set", "url", "not a url"], cli().io)).toBe(2);
  });

  it("use switches the current profile", async () => {
    expect(await run(["config", "use", "prod"], cli().io)).toBe(0);
    const config = await readConfig();
    expect(config.currentProfile).toBe("prod");
    expect(config.profiles.prod).toEqual({});
  });
});

describe("status", () => {
  it("reports api, database and queue health", async () => {
    await serve((request) => ({
      status: 200,
      body: request.path === "/health" ? { status: "ok" } : { status: "ready", database: "ok", queue: "ok" },
    }));
    const fake = cli({ env: { AGENTFLOW_URL: api!.url } });
    expect(await run(["status"], fake.io)).toBe(0);
    expect(fake.stdout()).toContain("api ok");
    expect(fake.stdout()).toContain("database ok");
    expect(fake.stdout()).toContain("queue ok");
  });

  it("exits 1 when the API is up but not ready", async () => {
    await serve((request) => (request.path === "/health"
      ? { status: 200, body: { status: "ok" } }
      : { status: 500, body: { error: "INTERNAL_ERROR" } }));
    const fake = cli({ env: { AGENTFLOW_URL: api!.url } });
    expect(await run(["status"], fake.io)).toBe(1);
    expect(fake.stdout()).toContain("api ok");
    expect(fake.stderr()).toContain("not ready");
  });
});
