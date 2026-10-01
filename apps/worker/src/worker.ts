import type { Database } from "@agentflow/db";
import type { AgentHarness } from "@agentflow/harness";
import {
  claimOperation,
  classifyOperationError,
  completeOperation,
  executeDeterministicOperation,
  executeToolOperation,
  renewOperationLease,
  settleOperationFailure,
  settleUnknownToolOutcome,
  UnknownEffectError,
} from "@agentflow/runtime";
import {
  operationJobSchema,
  queueName,
  setExecutionSpanAttributes,
  tracer,
} from "@agentflow/shared";
import {
  executeReferenceDeterministicOperation,
  isReferenceDeterministicHandler,
} from "@agentflow/research";
import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { executeBoundedAgentOperation } from "./agent.js";

export async function processOperationJob(
  database: Database,
  workerId: string,
  leaseMs: number,
  job: Job,
  heartbeatMs = Math.max(100, Math.floor(leaseMs / 3)),
  attemptTimeoutMs = 60_000,
  harness?: AgentHarness,
) {
  return tracer.startActiveSpan("agentflow.operation.execute", async (span) => {
    const message = operationJobSchema.parse(job.data);
    setExecutionSpanAttributes(span, {
      runId: message.runId,
      workflowVersionId: message.workflowVersionId,
      stepId: message.operationId,
    });
    const operation = await claimOperation(database, message, workerId, leaseMs, attemptTimeoutMs);
    if (!operation) {
      span.setAttribute("agentflow.operation.skipped", true);
      span.end();
      return { skipped: true, reason: "not-eligible" };
    }
    setExecutionSpanAttributes(span, {
      runId: operation.runId,
      workflowVersionId: operation.workflowVersionId,
      stepId: operation.operationId,
      stepKey: operation.nodeKey,
      stepKind: operation.kind,
      attemptId: operation.attemptId,
      attemptNumber: operation.attemptNo,
      leaseEpoch: operation.leaseEpoch,
    });

    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const heartbeat = async (): Promise<void> => {
      if (stopped) return;
      try {
        const renewed = await renewOperationLease(database, operation, leaseMs);
        if (!renewed) {
          stopped = true;
          return;
        }
      } catch (error) {
        console.error("Operation lease heartbeat failed", {
          operationId: operation.operationId,
          attemptId: operation.attemptId,
          error,
        });
      }
      if (!stopped) {
        timer = setTimeout(() => void heartbeat(), heartbeatMs);
        timer.unref();
      }
    };
    timer = setTimeout(() => void heartbeat(), heartbeatMs);
    timer.unref();

    try {
      let output: Record<string, unknown>;
      try {
        if (operation.kind === "TOOL") {
          output = await executeToolOperation(database, operation);
        } else if (operation.kind === "AGENT") {
          if (!harness) throw new Error("Worker has no agent harness configured");
          output = await executeBoundedAgentOperation(database, operation, harness);
        } else {
          output = isReferenceDeterministicHandler(operation.handler)
            ? await executeReferenceDeterministicOperation(database, operation)
            : executeDeterministicOperation(operation);
        }
      } catch (error) {
        if (error instanceof UnknownEffectError) {
          const settlement = await settleUnknownToolOutcome(database, operation, error);
          return { skipped: false, unknown: true, settlement };
        }
        const failure = classifyOperationError(error);
        span.setAttribute("agentflow.failure.class", failure.errorClass);
        const settlement = await settleOperationFailure(database, operation, failure);
        return { skipped: false, failed: true, failure, settlement };
      }
      const completion = await completeOperation(database, operation, output);
      return { skipped: false, ...completion };
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
      span.end();
    }
  });
}

export function createOperationWorker(options: {
  database: Database;
  connection: ConnectionOptions;
  workerId: string;
  leaseMs: number;
  attemptTimeoutMs?: number;
  heartbeatMs?: number;
  concurrency: number;
  queueName?: string;
  harness?: AgentHarness;
}) {
  return new Worker(
    options.queueName ?? queueName,
    (job) => processOperationJob(
      options.database,
      options.workerId,
      options.leaseMs,
      job,
      options.heartbeatMs ?? Math.max(100, Math.floor(options.leaseMs / 3)),
      options.attemptTimeoutMs ?? 60_000,
      options.harness,
    ),
    {
      connection: options.connection,
      concurrency: options.concurrency,
      lockDuration: options.leaseMs,
    },
  );
}
