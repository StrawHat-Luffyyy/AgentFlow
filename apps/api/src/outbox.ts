import type { Database } from "@agentflow/db";
import { operationJobSchema, queueName } from "@agentflow/shared";
import { Queue } from "bullmq";

export interface OutboxDispatcher {
  dispatchOnce(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

export function createOutboxDispatcher(
  database: Database,
  queue: Queue,
  pollMs: number,
): OutboxDispatcher {
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;

  async function dispatchOnce(): Promise<number> {
    const candidates = await database.query<{
      id: string;
      payload_json: unknown;
    }>(
      `SELECT id, payload_json
       FROM outbox
       WHERE published_at IS NULL AND available_at <= now()
       ORDER BY available_at, id
       LIMIT 25`,
    );

    let published = 0;
    for (const candidate of candidates.rows) {
      try {
        const job = operationJobSchema.parse(candidate.payload_json);
        await queue.add(queue.name, job, {
          jobId: `operation-${job.operationId}-${job.dispatchGeneration}`,
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 100,
        });
        await database.query(
          `UPDATE outbox
           SET published_at = COALESCE(published_at, now()), delivery_attempts = delivery_attempts + 1,
             last_error = NULL
           WHERE id = $1`,
          [candidate.id],
        );
        published += 1;
      } catch (error) {
        await database.query(
          `UPDATE outbox
           SET delivery_attempts = delivery_attempts + 1, last_error = $2
           WHERE id = $1`,
          [candidate.id, error instanceof Error ? error.message : String(error)],
        );
      }
    }
    return published;
  }

  async function tick(): Promise<void> {
    if (stopping) return;
    await dispatchOnce().catch((error) => {
      console.error("Outbox dispatch failed", error);
    });
    if (!stopping) timer = setTimeout(tick, pollMs);
  }

  return {
    dispatchOnce,
    start() {
      if (!timer && !stopping) timer = setTimeout(tick, 0);
    },
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      await queue.close();
    },
  };
}
