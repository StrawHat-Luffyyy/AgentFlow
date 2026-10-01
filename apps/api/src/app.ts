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
  listRuns,
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

export function createApp(database: Database, queue: Queue): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request: express.Request, response: express.Response) => response.json({ status: "ok" }));
  app.get("/ready", async (_request: express.Request, response: express.Response) => {
    await database.query("SELECT 1");
    await queue.waitUntilReady();
    response.json({ status: "ready", database: "ok", queue: "ok" });
  });

  app.get("/reference-corpora/cloud-comparison-v1", (_request, response) => {
    response.json(cloudComparisonCorpusManifest);
  });

  app.post("/reference-workflows/cloud-comparison", async (request, response) => {
    const setup = cloudComparisonSetupSchema.parse(request.body ?? {});
    const result = await ensureCloudComparisonWorkflow(database, setup);
    response.status(result.created ? 201 : 200).json(result);
  });

  app.post("/workflows", async (request: express.Request, response: express.Response) => {
    const body = createWorkflowSchema.parse(request.body);
    const workflow = await createWorkflow(database, body);
    response.status(201).json(workflow);
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
    const run = await createRun(database, body);
    response.status(201).json(run);
  });

  app.get("/runs", async (request: express.Request, response: express.Response) => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    response.json(await listRuns(database, query));
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
    const body = reconciliationDecisionSchema.parse(request.body);
    response.json(await reconcileToolExecution(database, toolExecutionId, body));
  });

  app.post("/approvals/:id/decisions", async (request: express.Request, response: express.Response) => {
    const approvalId = z.string().uuid().parse(request.params.id);
    const body = approvalDecisionSchema.parse(request.body);
    const reviewer = {
      id: z.string().trim().min(1).max(200).parse(request.header("x-agentflow-reviewer-id")),
      role: z.string().trim().min(1).max(100).parse(request.header("x-agentflow-reviewer-role")),
    };
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
