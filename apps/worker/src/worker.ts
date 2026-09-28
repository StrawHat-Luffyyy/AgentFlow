import type { Database } from "@agentflow/db";
import {
  claimOperation,
  completeOperation,
  executeDeterministicOperation,
} from "@agentflow/runtime";
import { operationJobSchema, queueName } from "@agentflow/shared";
import { Worker, type ConnectionOptions, type Job } from "bullmq";

export async function processOperationJob(
  database: Database,
  workerId: string,
  leaseMs: number,
  job: Job,
) {
  const message = operationJobSchema.parse(job.data);
  const operation = await claimOperation(database, message, workerId, leaseMs);
  if (!operation) return { skipped: true, reason: "not-eligible" };

  const output = executeDeterministicOperation(operation);
  const completion = await completeOperation(database, operation, output);
  return { skipped: false, ...completion };
}

export function createOperationWorker(options: {
  database: Database;
  connection: ConnectionOptions;
  workerId: string;
  leaseMs: number;
  concurrency: number;
  queueName?: string;
}) {
  return new Worker(
    options.queueName ?? queueName,
    (job) => processOperationJob(options.database, options.workerId, options.leaseMs, job),
    {
      connection: options.connection,
      concurrency: options.concurrency,
      lockDuration: options.leaseMs,
    },
  );
}
