import { createHash, randomUUID } from "node:crypto";
import type { Database, Transaction } from "@agentflow/db";
import { one, withTransaction } from "@agentflow/db";
import {
  canonicalJson,
  operationJobSchema,
  tracer,
  workflowDefinitionSchema,
  type OperationJob,
  type WorkflowDefinition,
} from "@agentflow/shared";

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function nextEventSequence(transaction: Transaction, runId: string): Promise<number> {
  const result = await transaction.query<{ next_sequence: number }>(
    "SELECT COALESCE(MAX(sequence), 0)::integer + 1 AS next_sequence FROM audit_events WHERE run_id = $1",
    [runId],
  );
  return result.rows[0]?.next_sequence ?? 1;
}

export async function createWorkflow(
  database: Database,
  input: { name: string; description: string },
) {
  const id = randomUUID();
  return one<{ id: string; name: string; description: string; createdAt: Date }>(
    database,
    `INSERT INTO workflows (id, name, description)
     VALUES ($1, $2, $3)
     RETURNING id, name, description, created_at AS "createdAt"`,
    [id, input.name, input.description],
  );
}

export async function createWorkflowVersion(
  database: Database,
  workflowId: string,
  version: number,
  definitionInput: WorkflowDefinition,
) {
  const definition = workflowDefinitionSchema.parse(definitionInput);
  const workflow = await database.query("SELECT 1 FROM workflows WHERE id = $1", [workflowId]);
  if (workflow.rowCount === 0) throw new NotFoundError("Workflow not found");

  const id = randomUUID();
  return one<{
    id: string;
    workflowId: string;
    version: number;
    definition: WorkflowDefinition;
    definitionHash: string;
    createdAt: Date;
  }>(
    database,
    `INSERT INTO workflow_versions
       (id, workflow_id, version, definition_json, definition_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id, workflow_id AS "workflowId", version,
       definition_json AS definition, definition_hash AS "definitionHash",
       created_at AS "createdAt"`,
    [id, workflowId, version, JSON.stringify(definition), hash(definition)],
  );
}

export async function createRun(
  database: Database,
  input: {
    workflowVersionId: string;
    input: Record<string, unknown>;
    creationKey?: string | undefined;
  },
) {
  return tracer.startActiveSpan("agentflow.run.create", async (span) => {
    try {
      return await withTransaction(database, async (transaction) => {
        if (input.creationKey !== undefined) {
          const existing = await transaction.query<{
            id: string;
            workflow_version_id: string;
            input_hash: string;
          }>(
            "SELECT id, workflow_version_id, input_hash FROM workflow_runs WHERE creation_key = $1",
            [input.creationKey],
          );
          const row = existing.rows[0];
          if (row) {
            if (
              row.workflow_version_id !== input.workflowVersionId ||
              row.input_hash !== hash(input.input)
            ) {
              throw new ConflictError("Creation key is already bound to different input");
            }
            return getRun(transaction, row.id);
          }
        }

        const version = await transaction.query<{
          definition_json: WorkflowDefinition;
        }>(
          "SELECT definition_json FROM workflow_versions WHERE id = $1",
          [input.workflowVersionId],
        );
        const versionRow = version.rows[0];
        if (!versionRow) throw new NotFoundError("Workflow version not found");
        const definition = workflowDefinitionSchema.parse(versionRow.definition_json);
        const firstDefinition = definition.steps[0];
        if (!firstDefinition) throw new ConflictError("Workflow version has no steps");

        const runId = randomUUID();
        const stepId = randomUUID();
        const checkpointId = randomUUID();
        const outboxId = randomUUID();
        const eventId = randomUUID();
        const job: OperationJob = {
          runId,
          operationId: stepId,
          workflowVersionId: input.workflowVersionId,
          dispatchGeneration: 1,
        };

        await transaction.query(
          `INSERT INTO workflow_runs
             (id, workflow_version_id, creation_key, input_json, input_hash, lifecycle)
           VALUES ($1, $2, $3, $4::jsonb, $5, 'OPEN')`,
          [
            runId,
            input.workflowVersionId,
            input.creationKey ?? null,
            JSON.stringify(input.input),
            hash(input.input),
          ],
        );
        await transaction.query(
          `INSERT INTO workflow_steps
             (id, run_id, node_key, position, kind, handler, status, input_json)
           VALUES ($1, $2, $3, 0, $4, $5, 'READY', $6::jsonb)`,
          [
            stepId,
            runId,
            firstDefinition.key,
            firstDefinition.kind,
            firstDefinition.handler,
            JSON.stringify(input.input),
          ],
        );
        await transaction.query(
          `INSERT INTO checkpoints
             (id, run_id, revision, workflow_version_id, cursor, reason, snapshot_json)
           VALUES ($1, $2, 0, $3, $4, 'RUN_CREATED', $5::jsonb)`,
          [
            checkpointId,
            runId,
            input.workflowVersionId,
            firstDefinition.key,
            JSON.stringify({ input: input.input, completedOperations: [] }),
          ],
        );
        await transaction.query(
          "UPDATE workflow_runs SET current_checkpoint_id = $1 WHERE id = $2",
          [checkpointId, runId],
        );
        await transaction.query(
          `INSERT INTO outbox
             (id, run_id, step_id, generation, kind, payload_json)
           VALUES ($1, $2, $3, 1, 'DISPATCH_OPERATION', $4::jsonb)`,
          [outboxId, runId, stepId, JSON.stringify(job)],
        );
        await transaction.query(
          `INSERT INTO audit_events
             (id, run_id, sequence, step_id, type, payload_json)
           VALUES ($1, $2, 1, $3, 'RUN_CREATED', $4::jsonb)`,
          [eventId, runId, stepId, JSON.stringify({ checkpointId, workflowVersionId: input.workflowVersionId })],
        );
        return getRun(transaction, runId);
      });
    } finally {
      span.end();
    }
  });
}

type Queryable = Pick<Database, "query"> | Pick<Transaction, "query">;

export async function getRun(database: Queryable, runId: string) {
  const runResult = await database.query<{
    id: string;
    workflowVersionId: string;
    lifecycle: string;
    input: Record<string, unknown>;
    stateRevision: number;
    currentCheckpointId: string;
    createdAt: Date;
    finishedAt: Date | null;
  }>(
    `SELECT id, workflow_version_id AS "workflowVersionId", lifecycle,
       input_json AS input, state_revision AS "stateRevision",
       current_checkpoint_id AS "currentCheckpointId", created_at AS "createdAt",
       finished_at AS "finishedAt"
     FROM workflow_runs WHERE id = $1`,
    [runId],
  );
  const run = runResult.rows[0];
  if (!run) throw new NotFoundError("Run not found");

  const [steps, checkpoint] = await Promise.all([
    database.query(
      `SELECT id, node_key AS "nodeKey", position, kind, handler, status,
         input_json AS input, accepted_output_json AS "acceptedOutput",
         attempt_count AS "attemptCount", lease_epoch AS "leaseEpoch",
         lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
         dispatch_generation AS "dispatchGeneration", created_at AS "createdAt",
         completed_at AS "completedAt"
       FROM workflow_steps WHERE run_id = $1 ORDER BY position`,
      [runId],
    ),
    database.query(
      `SELECT id, revision, parent_id AS "parentId", cursor, reason,
         snapshot_json AS snapshot, created_at AS "createdAt"
       FROM checkpoints WHERE id = $1`,
      [run.currentCheckpointId],
    ),
  ]);

  return { ...run, steps: steps.rows, checkpoint: checkpoint.rows[0] };
}

export async function getRunHistory(database: Database, runId: string) {
  const exists = await database.query("SELECT 1 FROM workflow_runs WHERE id = $1", [runId]);
  if (exists.rowCount === 0) throw new NotFoundError("Run not found");
  const events = await database.query(
    `SELECT id, sequence, step_id AS "stepId", attempt_id AS "attemptId",
       type, payload_json AS payload, created_at AS "createdAt"
     FROM audit_events WHERE run_id = $1 ORDER BY sequence`,
    [runId],
  );
  return events.rows;
}

export interface ClaimedOperation {
  runId: string;
  operationId: string;
  workflowVersionId: string;
  attemptId: string;
  attemptNo: number;
  leaseEpoch: number;
  workerId: string;
  nodeKey: string;
  handler: string;
  position: number;
  input: Record<string, unknown>;
}

export async function claimOperation(
  database: Database,
  rawJob: OperationJob,
  workerId: string,
  leaseMs: number,
): Promise<ClaimedOperation | null> {
  const job = operationJobSchema.parse(rawJob);
  return withTransaction(database, async (transaction) => {
    const result = await transaction.query<{
      run_id: string;
      operation_id: string;
      workflow_version_id: string;
      lifecycle: string;
      status: string;
      dispatch_generation: number;
      attempt_count: number;
      lease_epoch: number;
      node_key: string;
      handler: string;
      position: number;
      input_json: Record<string, unknown>;
    }>(
      `SELECT wr.id AS run_id, ws.id AS operation_id,
         wr.workflow_version_id, wr.lifecycle, ws.status,
         ws.dispatch_generation, ws.attempt_count, ws.lease_epoch,
         ws.node_key, ws.handler, ws.position, ws.input_json
       FROM workflow_runs wr
       JOIN workflow_steps ws ON ws.run_id = wr.id
       WHERE wr.id = $1 AND ws.id = $2
       FOR UPDATE OF wr, ws`,
      [job.runId, job.operationId],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.workflow_version_id !== job.workflowVersionId ||
      row.lifecycle !== "OPEN" ||
      row.status !== "READY" ||
      row.dispatch_generation !== job.dispatchGeneration
    ) {
      return null;
    }

    const attemptId = randomUUID();
    const attemptNo = row.attempt_count + 1;
    const leaseEpoch = row.lease_epoch + 1;
    await transaction.query(
      `UPDATE workflow_steps
       SET status = 'RUNNING', attempt_count = $1, lease_owner = $2,
         lease_epoch = $3, lease_expires_at = now() + ($4 * interval '1 millisecond')
       WHERE id = $5`,
      [attemptNo, workerId, leaseEpoch, leaseMs, row.operation_id],
    );
    await transaction.query(
      `INSERT INTO step_attempts
         (id, step_id, attempt_no, epoch, worker_id, status, deadline_at)
       VALUES ($1, $2, $3, $4, $5, 'RUNNING', now() + ($6 * interval '1 millisecond'))`,
      [attemptId, row.operation_id, attemptNo, leaseEpoch, workerId, leaseMs],
    );

    return {
      runId: row.run_id,
      operationId: row.operation_id,
      workflowVersionId: row.workflow_version_id,
      attemptId,
      attemptNo,
      leaseEpoch,
      workerId,
      nodeKey: row.node_key,
      handler: row.handler,
      position: row.position,
      input: row.input_json,
    };
  });
}

export async function renewOperationLease(
  database: Database,
  operation: ClaimedOperation,
  leaseMs: number,
): Promise<boolean> {
  const result = await database.query(
    `UPDATE workflow_steps
     SET lease_expires_at = now() + ($1 * interval '1 millisecond')
     WHERE id = $2 AND run_id = $3 AND status = 'RUNNING'
       AND lease_owner = $4 AND lease_epoch = $5
       AND lease_expires_at > now()`,
    [
      leaseMs,
      operation.operationId,
      operation.runId,
      operation.workerId,
      operation.leaseEpoch,
    ],
  );
  return result.rowCount === 1;
}

export interface SchedulingRepairResult {
  expiredLeases: number;
  recoveredDispatches: number;
}

/**
 * Repairs database-authoritative work that can no longer make progress.
 * Every mutation and replacement outbox intent is committed atomically.
 */
export async function repairScheduling(
  database: Database,
  dispatchRecoveryMs: number,
  batchSize = 25,
): Promise<SchedulingRepairResult> {
  return withTransaction(database, async (transaction) => {
    let expiredLeases = 0;
    let recoveredDispatches = 0;

    const expired = await transaction.query<{
      id: string;
      run_id: string;
      workflow_version_id: string;
      dispatch_generation: number;
      lease_epoch: number;
      attempt_id: string | null;
    }>(
      `SELECT ws.id, ws.run_id, wr.workflow_version_id,
         ws.dispatch_generation, ws.lease_epoch,
         (SELECT sa.id FROM step_attempts sa
          WHERE sa.step_id = ws.id AND sa.epoch = ws.lease_epoch
          ORDER BY sa.started_at DESC LIMIT 1) AS attempt_id
       FROM workflow_steps ws
       JOIN workflow_runs wr ON wr.id = ws.run_id
       WHERE wr.lifecycle = 'OPEN' AND ws.status = 'RUNNING'
         AND ws.lease_expires_at <= now()
       ORDER BY ws.lease_expires_at, ws.id
       LIMIT $1
       FOR UPDATE OF ws SKIP LOCKED`,
      [batchSize],
    );

    for (const row of expired.rows) {
      const generation = row.dispatch_generation + 1;
      if (row.attempt_id) {
        await transaction.query(
          `UPDATE step_attempts
           SET status = 'ABANDONED', finished_at = now(),
             error_json = jsonb_build_object('code', 'LEASE_EXPIRED', 'epoch', $2::integer)
           WHERE id = $1 AND status = 'RUNNING'`,
          [row.attempt_id, row.lease_epoch],
        );
      }
      await transaction.query(
        `UPDATE workflow_steps
         SET status = 'READY', lease_owner = NULL, lease_expires_at = NULL,
           dispatch_generation = $1
         WHERE id = $2`,
        [generation, row.id],
      );
      const job: OperationJob = {
        runId: row.run_id,
        operationId: row.id,
        workflowVersionId: row.workflow_version_id,
        dispatchGeneration: generation,
      };
      await transaction.query(
        `INSERT INTO outbox
           (id, run_id, step_id, generation, kind, payload_json)
         VALUES ($1, $2, $3, $4, 'DISPATCH_OPERATION', $5::jsonb)`,
        [randomUUID(), row.run_id, row.id, generation, JSON.stringify(job)],
      );
      const sequence = await nextEventSequence(transaction, row.run_id);
      await transaction.query(
        `INSERT INTO audit_events
           (id, run_id, sequence, step_id, attempt_id, type, payload_json)
         VALUES ($1, $2, $3, $4, $5, 'LEASE_EXPIRED', $6::jsonb)`,
        [
          randomUUID(),
          row.run_id,
          sequence,
          row.id,
          row.attempt_id,
          JSON.stringify({ expiredEpoch: row.lease_epoch, dispatchGeneration: generation }),
        ],
      );
      expiredLeases += 1;
    }

    const stranded = await transaction.query<{
      id: string;
      run_id: string;
      workflow_version_id: string;
      dispatch_generation: number;
    }>(
      `SELECT ws.id, ws.run_id, wr.workflow_version_id, ws.dispatch_generation
       FROM workflow_steps ws
       JOIN workflow_runs wr ON wr.id = ws.run_id
       LEFT JOIN outbox current_dispatch
         ON current_dispatch.step_id = ws.id
        AND current_dispatch.generation = ws.dispatch_generation
        AND current_dispatch.kind = 'DISPATCH_OPERATION'
       WHERE wr.lifecycle = 'OPEN' AND ws.status = 'READY'
         AND (
           current_dispatch.id IS NULL OR
           (current_dispatch.published_at IS NOT NULL AND
            current_dispatch.published_at <= now() - ($1 * interval '1 millisecond'))
         )
       ORDER BY ws.created_at, ws.id
       LIMIT $2
       FOR UPDATE OF ws SKIP LOCKED`,
      [dispatchRecoveryMs, batchSize],
    );

    for (const row of stranded.rows) {
      const generation = row.dispatch_generation + 1;
      await transaction.query(
        "UPDATE workflow_steps SET dispatch_generation = $1 WHERE id = $2",
        [generation, row.id],
      );
      const job: OperationJob = {
        runId: row.run_id,
        operationId: row.id,
        workflowVersionId: row.workflow_version_id,
        dispatchGeneration: generation,
      };
      await transaction.query(
        `INSERT INTO outbox
           (id, run_id, step_id, generation, kind, payload_json)
         VALUES ($1, $2, $3, $4, 'DISPATCH_OPERATION', $5::jsonb)`,
        [randomUUID(), row.run_id, row.id, generation, JSON.stringify(job)],
      );
      const sequence = await nextEventSequence(transaction, row.run_id);
      await transaction.query(
        `INSERT INTO audit_events
           (id, run_id, sequence, step_id, type, payload_json)
         VALUES ($1, $2, $3, $4, 'DISPATCH_RECOVERED', $5::jsonb)`,
        [randomUUID(), row.run_id, sequence, row.id, JSON.stringify({ dispatchGeneration: generation })],
      );
      recoveredDispatches += 1;
    }

    return { expiredLeases, recoveredDispatches };
  });
}

export function executeDeterministicOperation(
  operation: ClaimedOperation,
): Record<string, unknown> {
  if (operation.handler === "generate-summary") {
    const entries = Object.entries(operation.input)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${String(value)}`);
    return { summary: entries.join("; "), source: operation.input };
  }
  if (operation.handler === "finalize") {
    return { finalized: true, result: operation.input };
  }
  throw new Error(`Unsupported deterministic handler: ${operation.handler}`);
}

export async function completeOperation(
  database: Database,
  operation: ClaimedOperation,
  output: Record<string, unknown>,
) {
  return tracer.startActiveSpan("agentflow.operation.complete", async (span) => {
    try {
      return await withTransaction(database, async (transaction) => {
        const locked = await transaction.query<{
          lifecycle: string;
          state_revision: number;
          current_checkpoint_id: string;
          workflow_version_id: string;
          definition_json: WorkflowDefinition;
          status: string;
          lease_owner: string | null;
          lease_epoch: number;
          lease_valid: boolean;
          position: number;
        }>(
          `SELECT wr.lifecycle, wr.state_revision, wr.current_checkpoint_id,
             wr.workflow_version_id, wv.definition_json, ws.status,
             ws.lease_owner, ws.lease_epoch,
             (ws.lease_expires_at > now()) AS lease_valid, ws.position
           FROM workflow_runs wr
           JOIN workflow_versions wv ON wv.id = wr.workflow_version_id
           JOIN workflow_steps ws ON ws.run_id = wr.id
           WHERE wr.id = $1 AND ws.id = $2
           FOR UPDATE OF wr, ws`,
          [operation.runId, operation.operationId],
        );
        const row = locked.rows[0];
        if (!row) throw new NotFoundError("Operation not found");
        if (
          row.lifecycle !== "OPEN" ||
          row.status !== "RUNNING" ||
          row.lease_owner !== operation.workerId ||
          row.lease_epoch !== operation.leaseEpoch ||
          !row.lease_valid
        ) {
          throw new ConflictError("Operation completion rejected by lease fencing");
        }

        const attemptUpdate = await transaction.query(
          `UPDATE step_attempts SET status = 'SUCCEEDED', finished_at = now()
           WHERE id = $1 AND status = 'RUNNING' AND epoch = $2`,
          [operation.attemptId, operation.leaseEpoch],
        );
        if (attemptUpdate.rowCount !== 1) {
          throw new ConflictError("Attempt is no longer authoritative");
        }
        await transaction.query(
          `UPDATE workflow_steps
           SET status = 'SUCCEEDED', accepted_output_json = $1::jsonb,
             completed_at = now(), lease_owner = NULL, lease_expires_at = NULL
           WHERE id = $2`,
          [JSON.stringify(output), operation.operationId],
        );

        const definition = workflowDefinitionSchema.parse(row.definition_json);
        const nextDefinition = definition.steps[row.position + 1];
        const revision = row.state_revision + 1;
        const checkpointId = randomUUID();
        const successorId = nextDefinition ? randomUUID() : null;
        await transaction.query(
          `INSERT INTO checkpoints
             (id, run_id, revision, parent_id, workflow_version_id, cursor, reason, snapshot_json)
           VALUES ($1, $2, $3, $4, $5, $6, 'OPERATION_SUCCEEDED', $7::jsonb)`,
          [
            checkpointId,
            operation.runId,
            revision,
            row.current_checkpoint_id,
            row.workflow_version_id,
            nextDefinition?.key ?? null,
            JSON.stringify({
              completedOperation: operation.operationId,
              acceptedOutput: output,
              nextOperation: successorId,
            }),
          ],
        );

        if (nextDefinition && successorId) {
          await transaction.query(
            `INSERT INTO workflow_steps
               (id, run_id, node_key, position, kind, handler, status, input_json)
             VALUES ($1, $2, $3, $4, $5, $6, 'READY', $7::jsonb)`,
            [
              successorId,
              operation.runId,
              nextDefinition.key,
              row.position + 1,
              nextDefinition.kind,
              nextDefinition.handler,
              JSON.stringify(output),
            ],
          );
          const job: OperationJob = {
            runId: operation.runId,
            operationId: successorId,
            workflowVersionId: row.workflow_version_id,
            dispatchGeneration: 1,
          };
          await transaction.query(
            `INSERT INTO outbox
               (id, run_id, step_id, generation, kind, payload_json)
             VALUES ($1, $2, $3, 1, 'DISPATCH_OPERATION', $4::jsonb)`,
            [randomUUID(), operation.runId, successorId, JSON.stringify(job)],
          );
          await transaction.query(
            `UPDATE workflow_runs
             SET current_checkpoint_id = $1, state_revision = $2
             WHERE id = $3`,
            [checkpointId, revision, operation.runId],
          );
        } else {
          await transaction.query(
            `UPDATE workflow_runs
             SET current_checkpoint_id = $1, state_revision = $2,
               lifecycle = 'SUCCEEDED', finished_at = now()
             WHERE id = $3`,
            [checkpointId, revision, operation.runId],
          );
        }

        const sequence = await nextEventSequence(transaction, operation.runId);
        await transaction.query(
          `INSERT INTO audit_events
             (id, run_id, sequence, step_id, attempt_id, type, payload_json)
           VALUES ($1, $2, $3, $4, $5, 'OPERATION_SUCCEEDED', $6::jsonb)`,
          [
            randomUUID(),
            operation.runId,
            sequence,
            operation.operationId,
            operation.attemptId,
            JSON.stringify({ checkpointId, successorId }),
          ],
        );
        return { checkpointId, successorId, runCompleted: successorId === null };
      });
    } finally {
      span.end();
    }
  });
}
