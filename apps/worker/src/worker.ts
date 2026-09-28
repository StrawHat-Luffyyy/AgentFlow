import type { Database } from "@agentflow/db";
import {
  claimOperation,
  completeOperation,
  executeDeterministicOperation,
  renewOperationLease,
} from "@agentflow/runtime";
import { operationJobSchema, queueName } from "@agentflow/shared";
import { Worker, type ConnectionOptions, type Job } from "bullmq";

export async function processOperationJob(
  database: Database,
  workerId: string,
  leaseMs: number,
  job: Job,
  heartbeatMs = Math.max(100, Math.floor(leaseMs / 3)),
) {
  const message = operationJobSchema.parse(job.data);
  const operation = await claimOperation(database, message, workerId, leaseMs);
  if (!operation) return { skipped: true, reason: "not-eligible" };

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
    const output = await executeDeterministicOperation(operation);
    const completion = await completeOperation(database, operation, output);
    return { skipped: false, ...completion };
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
  }
}

export function createOperationWorker(options: {
  database: Database;
  connection: ConnectionOptions;
  workerId: string;
  leaseMs: number;
  heartbeatMs?: number;
  concurrency: number;
  queueName?: string;
}) {
  return new Worker(
    options.queueName ?? queueName,
    (job) => processOperationJob(
      options.database,
      options.workerId,
      options.leaseMs,
      job,
      options.heartbeatMs ?? Math.max(100, Math.floor(options.leaseMs / 3)),
    ),
    {
      connection: options.connection,
      concurrency: options.concurrency,
      lockDuration: options.leaseMs,
    },
  );
}
