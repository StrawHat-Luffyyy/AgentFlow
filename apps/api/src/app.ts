import { createHash, randomBytes } from "node:crypto";
import {
  authenticationMiddleware,
  bearerAuthentication,
  parseCookies,
  readCredentials,
  sessionCookieOptions,
  verifyPassword,
  type AuthenticatedPrincipal,
  type Credential,
} from "./auth.js";
import type { Database } from "@agentflow/db";
import {
  ConflictError,
  NotFoundError,
  createRun,
  createWorkflow,
  createWorkflowVersion,
  decideApproval,
  controlRun,
  getRun,
  getRunAttempts,
  getRunApprovals,
  getRunHistory,
  getRunHarnessOperations,
  getRunSources,
  getRunToolExecutions,
  getRunUsage,
  getWorkflow,
  listPendingApprovals,
  listRuns,
  listWorkflows,
  reconcileToolExecution,
} from "@agentflow/runtime";
import {
  approvalDecisionSchema,
  createRunSchema,
  createWorkflowSchema,
  createWorkflowVersionSchema,
  reconciliationDecisionSchema,
} from "@agentflow/shared";
import {
  cloudComparisonCorpusManifest,
  cloudComparisonSetupSchema,
  ensureCloudComparisonWorkflow,
} from "@agentflow/research";
import type { Queue } from "bullmq";
import express from "express";
import { z } from "zod";

export function createApp(database: Database, queue: Queue, credentials: readonly Credential[] = readCredentials()): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request: express.Request, response: express.Response) => response.json({ status: "ok" }));
  app.get("/ready", async (_request: express.Request, response: express.Response) => {
    await database.query("SELECT 1");
    await queue.waitUntilReady();
    response.json({ status: "ready", database: "ok", queue: "ok" });
  });

  app.post("/auth/login", async (request: express.Request, response: express.Response) => {
    const loginSchema = z.object({
      username: z.string().min(1).max(100),
      password: z.string().min(1).max(1000),
    });
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "INVALID_REQUEST_BODY", details: parsed.error.issues });
      return;
    }
    const { username, password } = parsed.data;
    const userResult = await database.query<{
      id: string;
      username: string;
      password_hash: string;
      roles: string[];
    }>(
      "SELECT id, username, password_hash, roles FROM web_users WHERE LOWER(username) = LOWER($1)",
      [username],
    );
    if (userResult.rowCount === 0 || !userResult.rows[0]) {
      response.status(401).json({ error: "INVALID_CREDENTIALS" });
      return;
    }
    const user = userResult.rows[0];
    if (!verifyPassword(password, user.password_hash)) {
      response.status(401).json({ error: "INVALID_CREDENTIALS" });
      return;
    }

    const sessionId = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await database.query(
      "INSERT INTO web_sessions (id, user_id, expires_at) VALUES ($1, $2, $3)",
      [sessionId, user.id, expiresAt],
    );
    response.cookie("agentflow_session", sessionId, sessionCookieOptions);
    response.json({
      user: {
        id: user.id,
        username: user.username,
        roles: user.roles,
      },
    });
  });

  app.post("/auth/logout", async (request: express.Request, response: express.Response) => {
    const cookies = parseCookies(request.header("cookie"));
    const sessionId = cookies["agentflow_session"];
    if (sessionId) {
      await database.query("DELETE FROM web_sessions WHERE id = $1", [sessionId]);
    }
    response.clearCookie("agentflow_session", { path: "/" });
    response.json({ status: "ok" });
  });

  app.use(authenticationMiddleware(database, credentials));
  app.get("/me", (_request, response) => {
    const principal = response.locals.principal as AuthenticatedPrincipal;
    response.json({
      id: principal.id,
      roles: principal.roles,
      ...(principal.username ? { username: principal.username } : {}),
    });
  });
  // Run ownership is inherited through its immutable workflow-version relationship.
  app.use(async (request, response, next) => {
    const principal = response.locals.principal as AuthenticatedPrincipal;
    const resource = /^\/(runs|workflows|approvals|tool-executions)\/([^/]+)/.exec(request.path);
    let sql: string | undefined;
    let id: string | undefined;
    if (resource) {
      id = z.string().uuid().parse(resource[2]);
      const kind = resource[1];
      if (kind === "workflows") sql = "SELECT 1 FROM workflows WHERE id = $1 AND owner_id = $2";
      else {
        const join = kind === "approvals" ? "JOIN approvals resource ON resource.run_id = wr.id"
          : kind === "tool-executions" ? "JOIN tool_executions resource ON resource.run_id = wr.id" : "";
        const identity = kind === "runs" ? "wr.id" : "resource.id";
        sql = `SELECT 1 FROM workflow_runs wr
          JOIN workflow_versions wv ON wv.id = wr.workflow_version_id
          JOIN workflows w ON w.id = wv.workflow_id ${join}
          WHERE ${identity} = $1 AND w.owner_id = $2`;
      }
    } else if (request.method === "POST" && request.path === "/runs") {
      id = createRunSchema.parse(request.body).workflowVersionId;
      sql = `SELECT 1 FROM workflow_versions wv JOIN workflows w ON w.id = wv.workflow_id
        WHERE wv.id = $1 AND w.owner_id = $2`;
    }
    if (sql && (await database.query(sql, [id, principal.id])).rowCount === 0) {
      response.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    next();
  });

  app.get("/reference-corpora/cloud-comparison-v1", (_request, response) => {
    response.json(cloudComparisonCorpusManifest);
  });

  app.post("/reference-workflows/cloud-comparison", async (request, response) => {
    const setup = cloudComparisonSetupSchema.parse(request.body ?? {});
    const result = await ensureCloudComparisonWorkflow(database, setup, response.locals.principal.id);
    response.status(result.created ? 201 : 200).json(result);
  });

  app.post("/workflows", async (request: express.Request, response: express.Response) => {
    const body = createWorkflowSchema.parse(request.body);
    const workflow = await createWorkflow(database, { ...body, ownerId: response.locals.principal.id });
    response.status(201).json(workflow);
  });

  app.get("/workflows", async (_request: express.Request, response: express.Response) => {
    response.json(await listWorkflows(database, { ownerId: response.locals.principal.id }));
  });

  app.get("/workflows/:id", async (request: express.Request, response: express.Response) => {
    const workflowId = z.string().uuid().parse(request.params.id);
    response.json(await getWorkflow(database, workflowId));
  });

  app.post("/workflows/:id/versions", async (request: express.Request, response: express.Response) => {
    const workflowId = z.string().uuid().parse(request.params.id);
    const body = createWorkflowVersionSchema.parse(request.body);
    const version = await createWorkflowVersion(
      database,
      workflowId,
      body.version,
      body.definition,
    );
    response.status(201).json(version);
  });

  app.post("/runs", async (request: express.Request, response: express.Response) => {
    const body = createRunSchema.parse(request.body);
    const run = await createRun(database, {
      ...body,
      // Prevent global creation-key collisions or cross-owner replay.
      ...(body.creationKey === undefined ? {} : {
        creationKey: createHash("sha256").update(JSON.stringify([response.locals.principal.id, body.creationKey])).digest("hex"),
      }),
    });
    response.status(201).json(run);
  });

  app.get("/runs", async (request: express.Request, response: express.Response) => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    response.json(await listRuns(database, { ...query, ownerId: response.locals.principal.id }));
  });

  app.get("/runs/:id", async (request: express.Request, response: express.Response) => {
    const runId = z.string().uuid().parse(request.params.id);
    response.json(await getRun(database, runId));
  });

  app.get("/runs/:id/history", async (request: express.Request, response: express.Response) => {
    const runId = z.string().uuid().parse(request.params.id);
    response.json({ events: await getRunHistory(database, runId) });
  });

  app.get("/runs/:id/attempts", async (request: express.Request, response: express.Response) => {
    const runId = z.string().uuid().parse(request.params.id);
    response.json({ attempts: await getRunAttempts(database, runId) });
  });

  app.get("/runs/:id/approvals", async (request: express.Request, response: express.Response) => {
    const runId = z.string().uuid().parse(request.params.id);
    response.json({ approvals: await getRunApprovals(database, runId) });
  });

  app.get("/runs/:id/tool-executions", async (request: express.Request, response: express.Response) => {
    const runId = z.string().uuid().parse(request.params.id);
    response.json({ executions: await getRunToolExecutions(database, runId) });
  });

  app.get("/runs/:id/harness-operations", async (request: express.Request, response: express.Response) => {
    const runId = z.string().uuid().parse(request.params.id);
    response.json({ operations: await getRunHarnessOperations(database, runId) });
  });

  app.get("/runs/:id/usage", async (request: express.Request, response: express.Response) => {
    const runId = z.string().uuid().parse(request.params.id);
    response.json({ usage: await getRunUsage(database, runId) });
  });

  app.get("/runs/:id/sources", async (request: express.Request, response: express.Response) => {
    const runId = z.string().uuid().parse(request.params.id);
    response.json({ sources: await getRunSources(database, runId) });
  });

  app.post("/tool-executions/:id/reconcile", async (request: express.Request, response: express.Response) => {
    const toolExecutionId = z.string().uuid().parse(request.params.id);
    if (!(response.locals.principal as AuthenticatedPrincipal).roles.includes("operator")) {
      response.status(403).json({ error: "FORBIDDEN" });
      return;
    }
    const body = reconciliationDecisionSchema.parse(request.body);
    response.json(await reconcileToolExecution(database, toolExecutionId, body));
  });

  app.get("/approvals", async (request: express.Request, response: express.Response) => {
    const query = z.object({ runId: z.string().uuid().optional() }).parse(request.query);
    const principal = response.locals.principal as AuthenticatedPrincipal;
    const approvals = await listPendingApprovals(database, {
      ownerId: principal.id,
      roles: principal.roles,
      ...(query.runId === undefined ? {} : { runId: query.runId }),
    });
    response.json({ approvals });
  });

  app.post("/approvals/:id/decisions", async (request: express.Request, response: express.Response) => {
    const approvalId = z.string().uuid().parse(request.params.id);
    const body = approvalDecisionSchema.parse(request.body);
    const principal = response.locals.principal as AuthenticatedPrincipal;
    const approval = await database.query<{ reviewer_role: string }>(
      "SELECT reviewer_role FROM approvals WHERE id = $1", [approvalId],
    );
    const role = approval.rows[0]?.reviewer_role;
    if (!role || !principal.roles.includes(role)) {
      response.status(403).json({ error: "FORBIDDEN" });
      return;
    }
    const reviewer = { id: principal.id, role };
    response.json(await decideApproval(database, approvalId, body, reviewer));
  });

  for (const command of ["pause", "resume", "cancel"] as const) {
    app.post(`/runs/:id/${command}`, async (request: express.Request, response: express.Response) => {
      const runId = z.string().uuid().parse(request.params.id);
      response.json(await controlRun(database, runId, command));
    });
  }

  app.use(
    (error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      if (error instanceof z.ZodError) {
        response.status(400).json({ error: "VALIDATION_ERROR", details: error.issues });
        return;
      }
      if (error instanceof NotFoundError) {
        response.status(404).json({ error: "NOT_FOUND", message: error.message });
        return;
      }
      if (error instanceof ConflictError) {
        response.status(409).json({ error: "CONFLICT", message: error.message });
        return;
      }
      // Body-parser rejections (malformed JSON, oversized payloads) carry a 4xx status.
      const clientError = error as { status?: unknown; type?: unknown };
      if (typeof clientError.status === "number" && clientError.status >= 400 && clientError.status < 500) {
        response.status(clientError.status).json({
          error: clientError.status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST_BODY",
          ...(typeof clientError.type === "string" ? { message: clientError.type } : {}),
        });
        return;
      }
      const databaseError = error as { code?: string; constraint?: string };
      if (databaseError.code === "23505") {
        response.status(409).json({
          error: "CONFLICT",
          message: "A resource with the same immutable identity already exists",
          constraint: databaseError.constraint,
        });
        return;
      }
      console.error(error);
      response.status(500).json({ error: "INTERNAL_ERROR" });
    },
  );

  return app;
}
