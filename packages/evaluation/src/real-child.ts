import { randomInt } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Queue, Worker } from "bullmq";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { migrate } from "@agentflow/db";
import { claimOperation, classifyOperationError, completeOperation, prepareToolExecution,
  publishToControlledReceiver, type ExecutionFaultHooks } from "@agentflow/runtime";
import { operationJobSchema } from "@agentflow/shared";
import { createApp } from "../../../apps/api/src/app.js";
import { readCredentials } from "../../../apps/api/src/auth.js";
import { createOutboxDispatcher } from "../../../apps/api/src/outbox.js";
import { createRecoveryScheduler } from "../../../apps/api/src/scheduler.js";
import { redisConnection } from "../../../apps/api/src/redis.js";
import { processOperationJob } from "../../../apps/worker/src/worker.js";
import { definition, Evidence, evidenceDatabase, executeCommonOperation, measuredHarness,
  publicationTarget, digest, type RealConfig } from "./real-common.js";

const config = JSON.parse(process.env.AGENTFLOW_EVALUATION_CONFIG!) as RealConfig;
const db = evidenceDatabase(config.databaseUrl);
const evidence = new Evidence(db, config);
const role = process.argv[2];
const connection = redisConnection(config.redisUrl);
const notify = (message: unknown) => process.send?.(message);
const initialInput = { publicationTarget: publicationTarget(config.trialId) };

async function boundedOperation(step: typeof definition.steps[number], input: Record<string, unknown>) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await executeCommonOperation(step, input, evidence); }
    catch (error) {
      const failure = classifyOperationError(error);
      await evidence.event("operation-error", step.key, failure);
      if (failure.errorClass === "PERMANENT" || attempt === 3) throw error;
      await delay(randomInt(config.retryMs * 2 ** (attempt - 1) + 1));
    }
  }
  throw new Error("Retry budget exhausted");
}

if (role === "api") {
  await migrate(db);
  const queue = new Queue(config.queue, { connection });
  const dispatcher = createOutboxDispatcher(db, queue, 20);
  const scheduler = createRecoveryScheduler(db, 50, 300);
  const port = Number(process.env.AGENTFLOW_API_PORT || config.apiPort || 0);
  const app = createApp(db, queue, readCredentials());
  const maxAttempts = 15;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = app.listen(port, "0.0.0.0", () => {
          const address = server.address();
          notify({ ready: true, port: typeof address === "object" && address ? address.port : port });
          resolve();
        });
        server.once("error", (err) => reject(err));
      });
      break;
    } catch (error: any) {
      if (error?.code === "EADDRINUSE" && attempt < maxAttempts) {
        await delay(300);
        continue;
      }
      throw error;
    }
  }
  dispatcher.start(); scheduler.start();
} else if (role === "worker") {
  const starts = new Map<string, number>();
  const hooks: ExecutionFaultHooks = {
    async hit(boundary, operation) {
      if (boundary === "completion-start") { starts.set(operation.operationId, performance.now()); return; }
      const detail = boundary === "after-checkpoint-commit"
        ? { checkpointMs: performance.now() - starts.get(operation.operationId)!, operationId: operation.operationId }
        : { operationId: operation.operationId, attempt: operation.attemptNo };
      if (boundary === "before-checkpoint-commit") return;
      await evidence.boundary(boundary, operation.nodeKey, detail);
    },
  };
  const worker = new Worker(config.queue, async (job) => {
    // A0 removes only receiver cooperation in this evaluation adapter. Production A1 is unchanged.
    const step = config.system === "A0"
      ? await db.query<{ kind: string }>("SELECT kind FROM workflow_steps WHERE id=$1", [job.data.operationId]) : null;
    if (step?.rows[0]?.kind === "TOOL") {
      const operation = await claimOperation(db, operationJobSchema.parse(job.data), `eval-${process.pid}`, config.leaseMs);
      if (!operation) return;
      await hooks.hit("before-operation", operation);
      const intent = await prepareToolExecution(db, operation);
      await evidence.event("effect-send", operation.nodeKey, { payloadHash: digest(operation.input) });
      const result = await publishToControlledReceiver(db, { ...intent, effectClass: "UNSAFE_WRITE" }, operation.input);
      await hooks.hit("after-receiver-commit", operation);
      return completeOperation(db, operation, { published: true, receiverId: result.receiverId, receipt: result.receipt }, hooks);
    }
    return processOperationJob(db, `eval-${process.pid}`, config.leaseMs, job,
      Math.max(100, Math.floor(config.leaseMs / 3)), 60_000, measuredHarness(evidence), hooks);
  }, { connection, concurrency: 1, lockDuration: config.leaseMs });
  worker.on("error", (error) => console.error(error));
  worker.on("failed", (_job, error) => console.error(error));
  await worker.waitUntilReady();
  notify({ ready: true });
} else {
  await evidence.event("process-ready");
  notify({ ready: true });
  try {
    if (config.system === "DBOS") {
      const workflow = DBOS.registerWorkflow(async () => {
        let state: Record<string, unknown> = initialInput;
        for (const step of definition.steps) {
          const input = state;
          state = await DBOS.runStep(() => boundedOperation(step, input), { name: step.key });
          await evidence.event("reference-checkpoint", step.key);
        }
        return state;
      }, { name: "matchedCloudComparison" });
      DBOS.setConfig({ name: "agentflow-matched-reference", applicationVersion: "acceptance-v1", systemDatabaseUrl: config.dbosUrl, enableOTLP: false });
      await DBOS.launch();
      const handle = await DBOS.startWorkflow(workflow, { workflowID: config.trialId, workflowIDReusePolicy: "return-existing" })();
      await handle.getResult();
      await evidence.event("reference-steps", null, await DBOS.listWorkflowSteps(handle.workflowID));
      await DBOS.shutdown();
    } else {
      // The supervisor preserves identity, but this process always starts with an empty cursor/state.
      let state: Record<string, unknown> = initialInput;
      for (const step of definition.steps) {
        state = await boundedOperation(step, state);
        await evidence.event("volatile-return", step.key, { outputHash: digest(state) });
      }
    }
    await db.query("UPDATE evaluation_trials SET outcome='SUCCEEDED', finished_at=clock_timestamp() WHERE id=$1", [config.trialId]);
    notify({ done: true });
  } catch (error) {
    await db.query("UPDATE evaluation_trials SET outcome='FAILED',error=$2,finished_at=clock_timestamp() WHERE id=$1", [config.trialId, String(error)]);
    notify({ done: true, error: String(error) });
  }
  await db.end();
  process.exit(0);
}
