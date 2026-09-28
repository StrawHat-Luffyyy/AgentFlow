import type { Database } from "@agentflow/db";
import {
  ConflictError,
  NotFoundError,
  createRun,
  createWorkflow,
  createWorkflowVersion,
  controlRun,
  getRun,
  getRunHistory,
} from "@agentflow/runtime";
import {
  createRunSchema,
  createWorkflowSchema,
  createWorkflowVersionSchema,
} from "@agentflow/shared";
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

  app.get("/runs/:id", async (request: express.Request, response: express.Response) => {
    const runId = z.string().uuid().parse(request.params.id);
    response.json(await getRun(database, runId));
  });

  app.get("/runs/:id/history", async (request: express.Request, response: express.Response) => {
    const runId = z.string().uuid().parse(request.params.id);
    response.json({ events: await getRunHistory(database, runId) });
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
