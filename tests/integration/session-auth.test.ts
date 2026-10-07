import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../apps/api/src/app.js";
import { ensureAdminUser, type Credential } from "../../apps/api/src/auth.js";
import { redisConnection } from "../../apps/api/src/redis.js";
import { createDatabase, migrate, type Database } from "@agentflow/db";
import { createHash, randomUUID } from "node:crypto";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://agentflow:agentflow@localhost:5432/agentflow_test";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const testCredentials: Credential[] = [
  {
    id: "acceptance-owner",
    tokenHash: createHash("sha256").update("bearer-test-token").digest("hex"),
    roles: ["research-reviewer", "operator"],
  },
];

describe("Session-cookie web authentication & API compatibility", () => {
  let database: Database;
  let queue: Queue;
  let server: Server;
  let baseUrl: string;
  const adminPassword = "super-secret-admin-pass-2026";

  beforeAll(async () => {
    database = createDatabase(databaseUrl);
    await migrate(database);
    await database.query("TRUNCATE web_sessions CASCADE");
    await ensureAdminUser(database, adminPassword, "admin");

    const connection = redisConnection(redisUrl);
    queue = new Queue("session-test-queue", { connection });

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
    await queue?.close();
    await database?.end();
  });

  it("provisions the acceptance-owner user with server-side roles and hashed password", async () => {
    const result = await database.query<{
      id: string;
      username: string;
      roles: string[];
    }>("SELECT id, username, roles FROM web_users WHERE id = $1", ["acceptance-owner"]);

    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.username).toBe("admin");
    expect(result.rows[0]?.roles).toEqual(["research-reviewer", "operator"]);
  });

  it("rejects invalid credentials on POST /auth/login with 401", async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong-password" }),
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: "INVALID_CREDENTIALS" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects unknown username on POST /auth/login with 401", async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nonexistent", password: adminPassword }),
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: "INVALID_CREDENTIALS" });
  });

  it("authenticates valid credentials, sets HTTP-only session cookie, and returns user identity", async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: adminPassword }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      user: {
        id: "acceptance-owner",
        username: "admin",
        roles: ["research-reviewer", "operator"],
      },
    });

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("agentflow_session=");
    expect(setCookie?.toLowerCase()).toContain("httponly");
    expect(setCookie?.toLowerCase()).toContain("samesite=lax");
  });

  it("validates session cookie on protected /me and API routes", async () => {
    // 1. Sign in to obtain session cookie
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: adminPassword }),
    });
    const setCookie = loginRes.headers.get("set-cookie")!;
    const cookieHeader = setCookie.split(";")[0]!;

    // 2. Call GET /me with session cookie
    const meRes = await fetch(`${baseUrl}/me`, {
      headers: { cookie: cookieHeader },
    });
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json();
    expect(meBody).toEqual({
      id: "acceptance-owner",
      roles: ["research-reviewer", "operator"],
      username: "admin",
    });

    // 3. Call GET /runs with session cookie (proves owner scoping resolves to acceptance-owner)
    const runsRes = await fetch(`${baseUrl}/runs`, {
      headers: { cookie: cookieHeader },
    });
    expect(runsRes.status).toBe(200);
  });

  it("preserves Bearer-token authentication concurrently alongside session cookies", async () => {
    // Call GET /me using Bearer header
    const response = await fetch(`${baseUrl}/me`, {
      headers: { authorization: "Bearer bearer-test-token" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      id: "acceptance-owner",
      roles: ["research-reviewer", "operator"],
    });
  });

  it("rejects unauthenticated requests without cookie or bearer token with 401", async () => {
    const response = await fetch(`${baseUrl}/me`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects expired session cookies with 401 and clears the cookie", async () => {
    // 1. Create a session that is already expired directly in database
    const expiredSessionId = randomUUID().replace(/-/g, "");
    await database.query(
      `INSERT INTO web_sessions (id, user_id, expires_at)
       VALUES ($1, $2, NOW() - INTERVAL '1 hour')`,
      [expiredSessionId, "acceptance-owner"],
    );

    // 2. Request with expired session
    const response = await fetch(`${baseUrl}/me`, {
      headers: { cookie: `agentflow_session=${expiredSessionId}` },
    });

    expect(response.status).toBe(401);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    // Cookie cleared
    expect(setCookie).toContain("agentflow_session=;");
  });

  it("logs out session on POST /auth/logout, invalidates DB session, and clears cookie", async () => {
    // 1. Login
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: adminPassword }),
    });
    const setCookie = loginRes.headers.get("set-cookie")!;
    const cookieHeader = setCookie.split(";")[0]!;
    const sessionId = cookieHeader.replace("agentflow_session=", "");

    // Verify session row exists
    const beforeCheck = await database.query(
      "SELECT 1 FROM web_sessions WHERE id = $1",
      [sessionId],
    );
    expect(beforeCheck.rowCount).toBe(1);

    // 2. Logout
    const logoutRes = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { cookie: cookieHeader },
    });
    expect(logoutRes.status).toBe(200);
    const logoutCookie = logoutRes.headers.get("set-cookie");
    expect(logoutCookie).toContain("agentflow_session=;");

    // Verify session row deleted
    const afterCheck = await database.query(
      "SELECT 1 FROM web_sessions WHERE id = $1",
      [sessionId],
    );
    expect(afterCheck.rowCount).toBe(0);

    // 3. Subsequent request with the same cookie is rejected
    const afterMeRes = await fetch(`${baseUrl}/me`, {
      headers: { cookie: cookieHeader },
    });
    expect(afterMeRes.status).toBe(401);
  });
});
