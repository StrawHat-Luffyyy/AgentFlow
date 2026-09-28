import { createHash, randomInt, randomUUID } from "node:crypto";
import type { Database, Transaction } from "@agentflow/db";
import { one, withTransaction } from "@agentflow/db";
import {
  canonicalJson,
  defaultRetryPolicy,
  operationJobSchema,
  tracer,
  workflowDefinitionSchema,
  type OperationJob,
  type RetryPolicy,
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
    deadlineMs?: number | undefined;
    retryPolicy?: RetryPolicy | undefined;
  },
) {
  return tracer.startActiveSpan("agentflow.run.create", async (span) => {
    try {
      return await withTransaction(database, async (transaction) => {
        const retryPolicy = input.retryPolicy ?? defaultRetryPolicy;
        const deadlineMs = input.deadlineMs ?? 300_000;
        if (input.creationKey !== undefined) {
          const existing = await transaction.query<{
            id: string;
            workflow_version_id: string;
            input_hash: string;
            deadline_ms: string;
            max_attempts: number;
            retry_initial_ms: number;
            retry_multiplier: number;
            retry_cap_ms: number;
          }>(
            `SELECT wr.id, wr.workflow_version_id, wr.input_hash,
               EXTRACT(EPOCH FROM (wr.deadline_at - wr.created_at)) * 1000 AS deadline_ms,
               ws.max_attempts, ws.retry_initial_ms, ws.retry_multiplier, ws.retry_cap_ms
             FROM workflow_runs wr
             JOIN workflow_steps ws ON ws.run_id = wr.id AND ws.position = 0
             WHERE wr.creation_key = $1`,
            [input.creationKey],
          );
          const row = existing.rows[0];
          if (row) {
            if (
              row.workflow_version_id !== input.workflowVersionId ||
              row.input_hash !== hash(input.input) ||
              Number(row.deadline_ms) !== deadlineMs ||
              row.max_attempts !== retryPolicy.maxAttempts ||
              row.retry_initial_ms !== retryPolicy.initialBackoffMs ||
              row.retry_multiplier !== retryPolicy.multiplier ||
              row.retry_cap_ms !== retryPolicy.maxBackoffMs
            ) {
              throw new ConflictError("Creation key is already bound to different input or policy");
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
             (id, workflow_version_id, creation_key, input_json, input_hash, lifecycle, deadline_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, 'OPEN', now() + ($6 * interval '1 millisecond'))`,
          [
            runId,
            input.workflowVersionId,
            input.creationKey ?? null,
            JSON.stringify(input.input),
            hash(input.input),
            deadlineMs,
          ],
        );
        await transaction.query(
          `INSERT INTO workflow_steps
             (id, run_id, node_key, position, kind, handler, status, input_json,
              max_attempts, retry_initial_ms, retry_multiplier, retry_cap_ms)
           VALUES ($1, $2, $3, 0, $4, $5, 'READY', $6::jsonb, $7, $8, $9, $10)`,
          [
            stepId,
            runId,
            firstDefinition.key,
            firstDefinition.kind,
            firstDefinition.handler,
            JSON.stringify(input.input),
            retryPolicy.maxAttempts,
            retryPolicy.initialBackoffMs,
            retryPolicy.multiplier,
            retryPolicy.maxBackoffMs,
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
    control: string;
    waitReason: string;
    input: Record<string, unknown>;
    stateRevision: number;
    currentCheckpointId: string;
    createdAt: Date;
    finishedAt: Date | null;
    deadlineAt: Date;
    failure: Record<string, unknown> | null;
  }>(
    `SELECT id, workflow_version_id AS "workflowVersionId", lifecycle, control,
       wait_reason AS "waitReason",
       input_json AS input, state_revision AS "stateRevision",
       current_checkpoint_id AS "currentCheckpointId", created_at AS "createdAt",
       finished_at AS "finishedAt", deadline_at AS "deadlineAt", failure_json AS failure
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
         next_attempt_at AS "nextAttemptAt", max_attempts AS "maxAttempts",
         failure_json AS failure,
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

  const stepRows = steps.rows as Array<{ status: string }>;
  const publicStatus = run.lifecycle !== "OPEN"
    ? run.lifecycle
    : run.control === "PAUSED" || run.control === "PAUSE_REQUESTED"
      ? run.control
      : run.control === "CANCEL_REQUESTED"
        ? "CANCEL_REQUESTED"
        : run.waitReason === "RETRY"
          ? "RETRY_WAIT"
          : stepRows.some((step) => step.status === "RUNNING")
            ? "RUNNING"
            : "QUEUED";
  return { ...run, publicStatus, steps: steps.rows, checkpoint: checkpoint.rows[0] };
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
  attemptTimeoutMs = leaseMs,
): Promise<ClaimedOperation | null> {
  const job = operationJobSchema.parse(rawJob);
  return withTransaction(database, async (transaction) => {
    const result = await transaction.query<{
      run_id: string;
      operation_id: string;
      workflow_version_id: string;
      lifecycle: string;
      control: string;
      wait_reason: string;
      deadline_valid: boolean;
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
         wr.workflow_version_id, wr.lifecycle, wr.control, wr.wait_reason,
         (wr.deadline_at > now()) AS deadline_valid, ws.status,
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
      row.control !== "RUN" ||
      row.wait_reason !== "NONE" ||
      !row.deadline_valid ||
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
      [attemptId, row.operation_id, attemptNo, leaseEpoch, workerId, attemptTimeoutMs],
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

export type OperationErrorClass = "TRANSIENT" | "PERMANENT" | "TIMEOUT";

export interface OperationFailure {
  code: string;
  errorClass: OperationErrorClass;
  message: string;
  retryable: boolean;
  retryAfterMs?: number | undefined;
}

export class RetryableOperationError extends Error {
  constructor(
    message: string,
    readonly code = "TRANSIENT_OPERATION_ERROR",
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class PermanentOperationError extends Error {
  constructor(message: string, readonly code = "PERMANENT_OPERATION_ERROR") {
    super(message);
  }
}

export class AttemptTimeoutError extends Error {
  constructor(message = "Operation attempt deadline exceeded") {
    super(message);
  }
}

export function classifyOperationError(error: unknown): OperationFailure {
  if (error instanceof RetryableOperationError) {
    return {
      code: error.code,
      errorClass: "TRANSIENT",
      message: error.message.slice(0, 1_000),
      retryable: true,
      retryAfterMs: error.retryAfterMs,
    };
  }
  if (error instanceof AttemptTimeoutError) {
    return {
      code: "ATTEMPT_TIMEOUT",
      errorClass: "TIMEOUT",
      message: error.message.slice(0, 1_000),
      retryable: true,
    };
  }
  if (error instanceof PermanentOperationError) {
    return {
      code: error.code,
      errorClass: "PERMANENT",
      message: error.message.slice(0, 1_000),
      retryable: false,
    };
  }
  return {
    code: "UNHANDLED_OPERATION_ERROR",
    errorClass: "PERMANENT",
    message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
    retryable: false,
  };
}

interface LockedFailureState {
  lifecycle: string;
  control: string;
  deadline_valid: boolean;
  status: string;
  lease_owner: string | null;
  lease_epoch: number;
  lease_valid: boolean;
  attempt_count: number;
  max_attempts: number;
  retry_initial_ms: number;
  retry_multiplier: number;
  retry_cap_ms: number;
}

function retryDelayMs(row: LockedFailureState, retryAfterMs?: number): number {
  const exponentialCap = Math.min(
    row.retry_cap_ms,
    row.retry_initial_ms * row.retry_multiplier ** Math.max(0, row.attempt_count - 1),
  );
  const sampled = exponentialCap <= 0 ? 0 : randomInt(Math.floor(exponentialCap) + 1);
  return Math.max(sampled, retryAfterMs ?? 0);
}

async function cancelLockedOperation(
  transaction: Transaction,
  operation: ClaimedOperation,
): Promise<{ cancelled: true }> {
  await transaction.query(
    `UPDATE step_attempts
     SET status = 'CANCELLED', finished_at = now(), error_class = 'PERMANENT',
       retryable = false,
       error_json = jsonb_build_object('code', 'RUN_CANCELLED')
     WHERE id = $1 AND status = 'RUNNING'`,
    [operation.attemptId],
  );
  await transaction.query(
    `UPDATE workflow_steps
     SET status = 'CANCELLED', lease_owner = NULL, lease_expires_at = NULL,
       next_attempt_at = NULL,
       failure_json = jsonb_build_object('code', 'RUN_CANCELLED')
     WHERE id = $1`,
    [operation.operationId],
  );
  await transaction.query(
    `UPDATE workflow_steps SET status = 'CANCELLED', next_attempt_at = NULL,
       failure_json = jsonb_build_object('code', 'RUN_CANCELLED')
     WHERE run_id = $1 AND status IN ('PENDING', 'READY', 'RETRY_WAIT')`,
    [operation.runId],
  );
  await transaction.query(
    `UPDATE workflow_runs
     SET lifecycle = 'CANCELLED', wait_reason = 'NONE', finished_at = now()
     WHERE id = $1`,
    [operation.runId],
  );
  const sequence = await nextEventSequence(transaction, operation.runId);
  await transaction.query(
    `INSERT INTO audit_events
       (id, run_id, sequence, step_id, attempt_id, type, payload_json)
     VALUES ($1, $2, $3, $4, $5, 'RUN_CANCELLED', '{}'::jsonb)`,
    [randomUUID(), operation.runId, sequence, operation.operationId, operation.attemptId],
  );
  return { cancelled: true };
}

export async function settleOperationFailure(
  database: Database,
  operation: ClaimedOperation,
  failure: OperationFailure,
): Promise<
  | { retryScheduled: true; nextAttemptAt: Date }
  | { retryScheduled: false; runFailed: true }
  | { retryScheduled: false; timedOut: true }
  | { retryScheduled: false; cancelled: true }
> {
  return withTransaction(database, async (transaction) => {
    const locked = await transaction.query<LockedFailureState>(
      `SELECT wr.lifecycle, wr.control, (wr.deadline_at > now()) AS deadline_valid,
         ws.status, ws.lease_owner, ws.lease_epoch,
         (ws.lease_expires_at > now()) AS lease_valid,
         ws.attempt_count, ws.max_attempts, ws.retry_initial_ms,
         ws.retry_multiplier, ws.retry_cap_ms
       FROM workflow_runs wr
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
      throw new ConflictError("Operation failure rejected by lease fencing");
    }
    if (row.control === "CANCEL_REQUESTED") {
      const cancelled = await cancelLockedOperation(transaction, operation);
      return { retryScheduled: false, ...cancelled };
    }

    const payload = { ...failure, attemptNo: operation.attemptNo };
    await transaction.query(
      `UPDATE step_attempts
       SET status = 'FAILED', finished_at = now(), error_class = $1,
         retryable = $2, error_json = $3::jsonb
       WHERE id = $4 AND status = 'RUNNING' AND epoch = $5`,
      [failure.errorClass, failure.retryable, JSON.stringify(payload), operation.attemptId, operation.leaseEpoch],
    );

    if (!row.deadline_valid) {
      const timeout = { code: "RUN_DEADLINE_EXCEEDED", cause: payload };
      await transaction.query(
        `UPDATE workflow_steps
         SET status = 'FAILED', lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = NULL, completed_at = now(), failure_json = $1::jsonb
         WHERE id = $2`,
        [JSON.stringify(timeout), operation.operationId],
      );
      await transaction.query(
        `UPDATE workflow_runs
         SET lifecycle = 'TIMED_OUT', wait_reason = 'NONE', failure_json = $1::jsonb,
           finished_at = now() WHERE id = $2`,
        [JSON.stringify(timeout), operation.runId],
      );
      const sequence = await nextEventSequence(transaction, operation.runId);
      await transaction.query(
        `INSERT INTO audit_events
           (id, run_id, sequence, step_id, attempt_id, type, payload_json)
         VALUES ($1, $2, $3, $4, $5, 'RUN_TIMED_OUT', $6::jsonb)`,
        [randomUUID(), operation.runId, sequence, operation.operationId, operation.attemptId, JSON.stringify(timeout)],
      );
      return { retryScheduled: false, timedOut: true };
    }

    const canRetry = failure.retryable && row.attempt_count < row.max_attempts;
    if (canRetry) {
      const delayMs = retryDelayMs(row, failure.retryAfterMs);
      const due = await transaction.query<{ next_attempt_at: Date }>(
        `UPDATE workflow_steps
         SET status = 'RETRY_WAIT', lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = LEAST(
             now() + ($1 * interval '1 millisecond'),
             (SELECT deadline_at FROM workflow_runs WHERE id = $2)
           ), failure_json = $3::jsonb
         WHERE id = $4
         RETURNING next_attempt_at`,
        [delayMs, operation.runId, JSON.stringify(payload), operation.operationId],
      );
      if (row.control === "PAUSE_REQUESTED") {
        await transaction.query(
          "UPDATE workflow_runs SET control = 'PAUSED', wait_reason = 'RETRY' WHERE id = $1",
          [operation.runId],
        );
      } else {
        await transaction.query(
          "UPDATE workflow_runs SET wait_reason = 'RETRY' WHERE id = $1",
          [operation.runId],
        );
      }
      const sequence = await nextEventSequence(transaction, operation.runId);
      await transaction.query(
        `INSERT INTO audit_events
           (id, run_id, sequence, step_id, attempt_id, type, payload_json)
         VALUES ($1, $2, $3, $4, $5, 'OPERATION_RETRY_SCHEDULED', $6::jsonb)`,
        [
          randomUUID(),
          operation.runId,
          sequence,
          operation.operationId,
          operation.attemptId,
          JSON.stringify({ ...payload, delayMs, nextAttemptAt: due.rows[0]?.next_attempt_at }),
        ],
      );
      return { retryScheduled: true, nextAttemptAt: due.rows[0]!.next_attempt_at };
    }

    const terminalFailure = {
      ...payload,
      exhausted: failure.retryable && row.attempt_count >= row.max_attempts,
    };
    await transaction.query(
      `UPDATE workflow_steps
       SET status = 'FAILED', lease_owner = NULL, lease_expires_at = NULL,
         next_attempt_at = NULL, completed_at = now(), failure_json = $1::jsonb
       WHERE id = $2`,
      [JSON.stringify(terminalFailure), operation.operationId],
    );
    await transaction.query(
      `UPDATE workflow_runs
       SET lifecycle = 'FAILED', wait_reason = 'NONE', failure_json = $1::jsonb,
         finished_at = now()
       WHERE id = $2`,
      [JSON.stringify(terminalFailure), operation.runId],
    );
    const sequence = await nextEventSequence(transaction, operation.runId);
    await transaction.query(
      `INSERT INTO audit_events
         (id, run_id, sequence, step_id, attempt_id, type, payload_json)
       VALUES ($1, $2, $3, $4, $5, 'OPERATION_FAILED', $6::jsonb)`,
      [randomUUID(), operation.runId, sequence, operation.operationId, operation.attemptId, JSON.stringify(terminalFailure)],
    );
    return { retryScheduled: false, runFailed: true };
  });
}

export type RunControlCommand = "pause" | "resume" | "cancel";

export async function controlRun(
  database: Database,
  runId: string,
  command: RunControlCommand,
) {
  return withTransaction(database, async (transaction) => {
    const runResult = await transaction.query<{
      lifecycle: string;
      control: string;
      wait_reason: string;
      state_revision: number;
      current_checkpoint_id: string;
      workflow_version_id: string;
    }>(
      `SELECT lifecycle, control, wait_reason, state_revision,
         current_checkpoint_id, workflow_version_id
       FROM workflow_runs WHERE id = $1 FOR UPDATE`,
      [runId],
    );
    const run = runResult.rows[0];
    if (!run) throw new NotFoundError("Run not found");
    if (run.lifecycle !== "OPEN") throw new ConflictError("Terminal run cannot be controlled");

    const steps = await transaction.query<{ id: string; status: string; dispatch_generation: number }>(
      `SELECT id, status, dispatch_generation FROM workflow_steps
       WHERE run_id = $1 AND status IN ('PENDING', 'READY', 'RUNNING', 'RETRY_WAIT')
       ORDER BY position FOR UPDATE`,
      [runId],
    );
    const running = steps.rows.find((step) => step.status === "RUNNING");
    let nextControl = run.control;
    let eventType: string;

    if (command === "pause") {
      if (run.control === "CANCEL_REQUESTED") throw new ConflictError("Cancellation is already requested");
      nextControl = running ? "PAUSE_REQUESTED" : "PAUSED";
      eventType = nextControl === "PAUSED" ? "RUN_PAUSED" : "RUN_PAUSE_REQUESTED";
    } else if (command === "resume") {
      if (run.control !== "PAUSED" && run.control !== "PAUSE_REQUESTED") {
        throw new ConflictError("Run is not paused");
      }
      nextControl = "RUN";
      eventType = "RUN_RESUMED";
      for (const step of steps.rows.filter((candidate) => candidate.status === "READY")) {
        const generation = step.dispatch_generation + 1;
        await transaction.query(
          "UPDATE workflow_steps SET dispatch_generation = $1 WHERE id = $2",
          [generation, step.id],
        );
        const job: OperationJob = {
          runId,
          operationId: step.id,
          workflowVersionId: run.workflow_version_id,
          dispatchGeneration: generation,
        };
        await transaction.query(
          `INSERT INTO outbox (id, run_id, step_id, generation, kind, payload_json)
           VALUES ($1, $2, $3, $4, 'DISPATCH_OPERATION', $5::jsonb)`,
          [randomUUID(), runId, step.id, generation, JSON.stringify(job)],
        );
      }
    } else {
      nextControl = "CANCEL_REQUESTED";
      eventType = "RUN_CANCEL_REQUESTED";
      if (!running) {
        await transaction.query(
          `UPDATE workflow_steps SET status = 'CANCELLED', next_attempt_at = NULL,
             failure_json = jsonb_build_object('code', 'RUN_CANCELLED')
           WHERE run_id = $1 AND status IN ('PENDING', 'READY', 'RETRY_WAIT')`,
          [runId],
        );
        await transaction.query(
          `UPDATE workflow_runs SET lifecycle = 'CANCELLED', control = $2,
             wait_reason = 'NONE', finished_at = now()
           WHERE id = $1`,
          [runId, nextControl],
        );
        eventType = "RUN_CANCELLED";
      }
    }

    if (!(command === "cancel" && !running)) {
      await transaction.query("UPDATE workflow_runs SET control = $2 WHERE id = $1", [runId, nextControl]);
    }
    const current = await transaction.query<{
      lifecycle: string;
      control: string;
      wait_reason: string;
    }>(
      "SELECT lifecycle, control, wait_reason FROM workflow_runs WHERE id = $1",
      [runId],
    );
    const checkpointId = randomUUID();
    const revision = run.state_revision + 1;
    const parentCheckpoint = await transaction.query<{
      cursor: string | null;
      snapshot_json: Record<string, unknown>;
    }>(
      "SELECT cursor, snapshot_json FROM checkpoints WHERE id = $1",
      [run.current_checkpoint_id],
    );
    const parent = parentCheckpoint.rows[0];
    await transaction.query(
      `INSERT INTO checkpoints
         (id, run_id, revision, parent_id, workflow_version_id, cursor, reason, snapshot_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        checkpointId,
        runId,
        revision,
        run.current_checkpoint_id,
        run.workflow_version_id,
        parent?.cursor ?? null,
        eventType,
        JSON.stringify({ ...(parent?.snapshot_json ?? {}), control: { command, ...current.rows[0] } }),
      ],
    );
    await transaction.query(
      `UPDATE workflow_runs SET current_checkpoint_id = $1, state_revision = $2
       WHERE id = $3`,
      [checkpointId, revision, runId],
    );
    const sequence = await nextEventSequence(transaction, runId);
    await transaction.query(
      `INSERT INTO audit_events (id, run_id, sequence, type, payload_json)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [randomUUID(), runId, sequence, eventType, JSON.stringify({ previousControl: run.control, control: nextControl })],
    );
    return getRun(transaction, runId);
  });
}

export interface SchedulingRepairResult {
  expiredLeases: number;
  recoveredDispatches: number;
  dueRetries: number;
  timedOutRuns: number;
  settledCancellations: number;
  failedOperations: number;
  timedOutAttempts: number;
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
    let dueRetries = 0;
    let timedOutRuns = 0;
    let settledCancellations = 0;
    let failedOperations = 0;
    let timedOutAttempts = 0;

    const timedOut = await transaction.query<{ id: string }>(
      `SELECT id FROM workflow_runs
       WHERE lifecycle = 'OPEN' AND deadline_at <= now()
       ORDER BY deadline_at, id LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    for (const run of timedOut.rows) {
      await transaction.query(
        `UPDATE step_attempts SET status = 'FAILED', finished_at = now(),
           error_class = 'TIMEOUT', retryable = false,
           error_json = jsonb_build_object('code', 'RUN_DEADLINE_EXCEEDED')
         WHERE status = 'RUNNING' AND step_id IN
           (SELECT id FROM workflow_steps WHERE run_id = $1)`,
        [run.id],
      );
      await transaction.query(
        `UPDATE workflow_steps SET status = 'FAILED', lease_owner = NULL,
           lease_expires_at = NULL, next_attempt_at = NULL, completed_at = now(),
           failure_json = jsonb_build_object('code', 'RUN_DEADLINE_EXCEEDED')
         WHERE run_id = $1 AND status IN ('PENDING', 'READY', 'RUNNING', 'RETRY_WAIT')`,
        [run.id],
      );
      await transaction.query(
        `UPDATE workflow_runs SET lifecycle = 'TIMED_OUT', wait_reason = 'NONE',
           failure_json = jsonb_build_object('code', 'RUN_DEADLINE_EXCEEDED'),
           finished_at = now() WHERE id = $1`,
        [run.id],
      );
      const sequence = await nextEventSequence(transaction, run.id);
      await transaction.query(
        `INSERT INTO audit_events (id, run_id, sequence, type, payload_json)
         VALUES ($1, $2, $3, 'RUN_TIMED_OUT', '{"code":"RUN_DEADLINE_EXCEEDED"}'::jsonb)`,
        [randomUUID(), run.id, sequence],
      );
      timedOutRuns += 1;
    }

    const cancellations = await transaction.query<{ id: string }>(
      `SELECT id FROM workflow_runs
       WHERE lifecycle = 'OPEN' AND control = 'CANCEL_REQUESTED'
       ORDER BY created_at, id LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    for (const run of cancellations.rows) {
      await transaction.query(
        `UPDATE step_attempts SET status = 'CANCELLED', finished_at = now(),
           error_class = 'PERMANENT', retryable = false,
           error_json = jsonb_build_object('code', 'RUN_CANCELLED')
         WHERE status = 'RUNNING' AND step_id IN
           (SELECT id FROM workflow_steps WHERE run_id = $1)`,
        [run.id],
      );
      await transaction.query(
        `UPDATE workflow_steps SET status = 'CANCELLED', lease_owner = NULL,
           lease_expires_at = NULL, next_attempt_at = NULL,
           failure_json = jsonb_build_object('code', 'RUN_CANCELLED')
         WHERE run_id = $1 AND status IN ('PENDING', 'READY', 'RUNNING', 'RETRY_WAIT')`,
        [run.id],
      );
      await transaction.query(
        `UPDATE workflow_runs SET lifecycle = 'CANCELLED', wait_reason = 'NONE',
           finished_at = now() WHERE id = $1`,
        [run.id],
      );
      const sequence = await nextEventSequence(transaction, run.id);
      await transaction.query(
        `INSERT INTO audit_events (id, run_id, sequence, type, payload_json)
         VALUES ($1, $2, $3, 'RUN_CANCELLED', '{}'::jsonb)`,
        [randomUUID(), run.id, sequence],
      );
      settledCancellations += 1;
    }

    const expired = await transaction.query<{
      id: string;
      run_id: string;
      control: string;
      lease_epoch: number;
      attempt_id: string | null;
      attempt_count: number;
      max_attempts: number;
      retry_initial_ms: number;
      retry_multiplier: number;
      retry_cap_ms: number;
      attempt_timed_out: boolean;
    }>(
      `SELECT ws.id, ws.run_id, wr.control, ws.lease_epoch,
         ws.attempt_count, ws.max_attempts, ws.retry_initial_ms,
         ws.retry_multiplier, ws.retry_cap_ms,
         (SELECT sa.id FROM step_attempts sa
          WHERE sa.step_id = ws.id AND sa.epoch = ws.lease_epoch
          ORDER BY sa.started_at DESC LIMIT 1) AS attempt_id,
         EXISTS (SELECT 1 FROM step_attempts sa
           WHERE sa.step_id = ws.id AND sa.epoch = ws.lease_epoch
             AND sa.deadline_at <= now()) AS attempt_timed_out
       FROM workflow_steps ws
       JOIN workflow_runs wr ON wr.id = ws.run_id
       WHERE wr.lifecycle = 'OPEN' AND ws.status = 'RUNNING'
         AND (ws.lease_expires_at <= now() OR EXISTS (
           SELECT 1 FROM step_attempts sa
           WHERE sa.step_id = ws.id AND sa.epoch = ws.lease_epoch
             AND sa.status = 'RUNNING' AND sa.deadline_at <= now()
         ))
       ORDER BY ws.lease_expires_at, ws.id
       LIMIT $1
       FOR UPDATE OF wr, ws SKIP LOCKED`,
      [batchSize],
    );

    for (const row of expired.rows) {
      const code = row.attempt_timed_out ? "ATTEMPT_TIMEOUT" : "LEASE_EXPIRED";
      if (row.attempt_id) {
        await transaction.query(
          `UPDATE step_attempts
           SET status = $3, finished_at = now(), error_class = $4,
             retryable = true,
             error_json = jsonb_build_object('code', $5::text, 'epoch', $2::integer)
           WHERE id = $1 AND status = 'RUNNING'`,
          [
            row.attempt_id,
            row.lease_epoch,
            row.attempt_timed_out ? "FAILED" : "ABANDONED",
            row.attempt_timed_out ? "TIMEOUT" : "TRANSIENT",
            code,
          ],
        );
      }
      const canRetry = row.attempt_count < row.max_attempts;
      let delayMs: number | null = null;
      if (canRetry) {
        delayMs = retryDelayMs({
          lifecycle: "OPEN",
          control: row.control,
          deadline_valid: true,
          status: "RUNNING",
          lease_owner: null,
          lease_epoch: row.lease_epoch,
          lease_valid: false,
          attempt_count: row.attempt_count,
          max_attempts: row.max_attempts,
          retry_initial_ms: row.retry_initial_ms,
          retry_multiplier: row.retry_multiplier,
          retry_cap_ms: row.retry_cap_ms,
        });
        await transaction.query(
          `UPDATE workflow_steps
           SET status = 'RETRY_WAIT', lease_owner = NULL, lease_expires_at = NULL,
             next_attempt_at = LEAST(
               now() + ($1 * interval '1 millisecond'),
               (SELECT deadline_at FROM workflow_runs WHERE id = $3)
             ),
             failure_json = jsonb_build_object('code', $2::text)
           WHERE id = $4`,
          [delayMs, code, row.run_id, row.id],
        );
        await transaction.query(
          `UPDATE workflow_runs
           SET wait_reason = 'RETRY',
             control = CASE WHEN control = 'PAUSE_REQUESTED' THEN 'PAUSED' ELSE control END
           WHERE id = $1`,
          [row.run_id],
        );
      } else {
        const failure = { code, exhausted: true, maxAttempts: row.max_attempts };
        await transaction.query(
          `UPDATE workflow_steps SET status = 'FAILED', lease_owner = NULL,
             lease_expires_at = NULL, next_attempt_at = NULL, completed_at = now(),
             failure_json = $1::jsonb WHERE id = $2`,
          [JSON.stringify(failure), row.id],
        );
        await transaction.query(
          `UPDATE workflow_runs SET lifecycle = 'FAILED', wait_reason = 'NONE',
             failure_json = $1::jsonb, finished_at = now() WHERE id = $2`,
          [JSON.stringify(failure), row.run_id],
        );
        failedOperations += 1;
      }
      const sequence = await nextEventSequence(transaction, row.run_id);
      await transaction.query(
        `INSERT INTO audit_events
           (id, run_id, sequence, step_id, attempt_id, type, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          randomUUID(),
          row.run_id,
          sequence,
          row.id,
          row.attempt_id,
          code,
          JSON.stringify({ expiredEpoch: row.lease_epoch, retryScheduled: canRetry, delayMs }),
        ],
      );
      if (row.attempt_timed_out) timedOutAttempts += 1;
      else expiredLeases += 1;
    }

    const due = await transaction.query<{
      id: string;
      run_id: string;
      workflow_version_id: string;
      dispatch_generation: number;
    }>(
      `SELECT ws.id, ws.run_id, wr.workflow_version_id, ws.dispatch_generation
       FROM workflow_steps ws
       JOIN workflow_runs wr ON wr.id = ws.run_id
       WHERE wr.lifecycle = 'OPEN' AND wr.control = 'RUN'
         AND wr.wait_reason = 'RETRY' AND wr.deadline_at > now()
         AND ws.status = 'RETRY_WAIT' AND ws.next_attempt_at < now()
       ORDER BY ws.next_attempt_at, ws.id LIMIT $1
       FOR UPDATE OF wr, ws SKIP LOCKED`,
      [batchSize],
    );
    for (const row of due.rows) {
      const generation = row.dispatch_generation + 1;
      await transaction.query(
        `UPDATE workflow_steps SET status = 'READY', next_attempt_at = NULL,
           dispatch_generation = $1 WHERE id = $2`,
        [generation, row.id],
      );
      await transaction.query("UPDATE workflow_runs SET wait_reason = 'NONE' WHERE id = $1", [row.run_id]);
      const job: OperationJob = {
        runId: row.run_id,
        operationId: row.id,
        workflowVersionId: row.workflow_version_id,
        dispatchGeneration: generation,
      };
      await transaction.query(
        `INSERT INTO outbox (id, run_id, step_id, generation, kind, payload_json)
         VALUES ($1, $2, $3, $4, 'DISPATCH_OPERATION', $5::jsonb)`,
        [randomUUID(), row.run_id, row.id, generation, JSON.stringify(job)],
      );
      const sequence = await nextEventSequence(transaction, row.run_id);
      await transaction.query(
        `INSERT INTO audit_events (id, run_id, sequence, step_id, type, payload_json)
         VALUES ($1, $2, $3, $4, 'RETRY_DUE', $5::jsonb)`,
        [randomUUID(), row.run_id, sequence, row.id, JSON.stringify({ dispatchGeneration: generation })],
      );
      dueRetries += 1;
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
       WHERE wr.lifecycle = 'OPEN' AND wr.control = 'RUN'
         AND wr.wait_reason = 'NONE' AND wr.deadline_at > now()
         AND ws.status = 'READY'
         AND (
           current_dispatch.id IS NULL OR
           (current_dispatch.published_at IS NOT NULL AND
            current_dispatch.published_at <= now() - ($1 * interval '1 millisecond'))
         )
       ORDER BY ws.created_at, ws.id
       LIMIT $2
       FOR UPDATE OF wr, ws SKIP LOCKED`,
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

    return {
      expiredLeases,
      recoveredDispatches,
      dueRetries,
      timedOutRuns,
      settledCancellations,
      failedOperations,
      timedOutAttempts,
    };
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
          control: string;
          deadline_valid: boolean;
          state_revision: number;
          current_checkpoint_id: string;
          workflow_version_id: string;
          definition_json: WorkflowDefinition;
          status: string;
          lease_owner: string | null;
          lease_epoch: number;
          lease_valid: boolean;
          position: number;
          max_attempts: number;
          retry_initial_ms: number;
          retry_multiplier: number;
          retry_cap_ms: number;
        }>(
          `SELECT wr.lifecycle, wr.control, (wr.deadline_at > now()) AS deadline_valid,
             wr.state_revision, wr.current_checkpoint_id,
             wr.workflow_version_id, wv.definition_json, ws.status,
             ws.lease_owner, ws.lease_epoch,
             (ws.lease_expires_at > now()) AS lease_valid, ws.position,
             ws.max_attempts, ws.retry_initial_ms, ws.retry_multiplier, ws.retry_cap_ms
           FROM workflow_runs wr
           JOIN workflow_versions wv ON wv.id = wr.workflow_version_id
           JOIN workflow_steps ws ON ws.run_id = wr.id
           WHERE wr.id = $1 AND ws.id = $2
           FOR UPDATE OF wr, ws`,
          [operation.runId, operation.operationId],
        );
        const row = locked.rows[0];
        if (!row) throw new NotFoundError("Operation not found");
        if (row.control === "CANCEL_REQUESTED" && row.lifecycle === "OPEN") {
          return cancelLockedOperation(transaction, operation);
        }
        if (
          row.lifecycle !== "OPEN" ||
          (row.control !== "RUN" && row.control !== "PAUSE_REQUESTED") ||
          !row.deadline_valid ||
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
             completed_at = now(), lease_owner = NULL, lease_expires_at = NULL,
             next_attempt_at = NULL, failure_json = NULL
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
               (id, run_id, node_key, position, kind, handler, status, input_json,
                max_attempts, retry_initial_ms, retry_multiplier, retry_cap_ms)
             VALUES ($1, $2, $3, $4, $5, $6, 'READY', $7::jsonb, $8, $9, $10, $11)`,
            [
              successorId,
              operation.runId,
              nextDefinition.key,
              row.position + 1,
              nextDefinition.kind,
              nextDefinition.handler,
              JSON.stringify(output),
              row.max_attempts,
              row.retry_initial_ms,
              row.retry_multiplier,
              row.retry_cap_ms,
            ],
          );
          if (row.control === "RUN") {
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
          }
          await transaction.query(
            `UPDATE workflow_runs
             SET current_checkpoint_id = $1, state_revision = $2,
               control = CASE WHEN control = 'PAUSE_REQUESTED' THEN 'PAUSED' ELSE control END
             WHERE id = $3`,
            [checkpointId, revision, operation.runId],
          );
        } else {
          await transaction.query(
            `UPDATE workflow_runs
             SET current_checkpoint_id = $1, state_revision = $2,
               lifecycle = 'SUCCEEDED', control = 'RUN', wait_reason = 'NONE',
               finished_at = now()
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
