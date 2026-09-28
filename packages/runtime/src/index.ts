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
  type ApprovalDecision,
  type ReconciliationDecision,
  type RetryPolicy,
  type WorkflowDefinition,
  type WorkflowStepDefinition,
} from "@agentflow/shared";

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

interface StepPolicy {
  maxAttempts: number;
  initialBackoffMs: number;
  multiplier: number;
  maxBackoffMs: number;
}

async function materializeStep(
  transaction: Transaction,
  input: {
    runId: string;
    workflowVersionId: string;
    position: number;
    definition: WorkflowStepDefinition;
    stepInput: Record<string, unknown>;
    policy: StepPolicy;
    control: string;
  },
): Promise<{ stepId: string; approvalId: string | null }> {
  const stepId = randomUUID();
  const waitingForApproval = input.definition.kind === "APPROVAL";
  await transaction.query(
    `INSERT INTO workflow_steps
       (id, run_id, node_key, position, kind, handler, effect_class, tool_version,
        status, input_json, max_attempts, retry_initial_ms, retry_multiplier, retry_cap_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)`,
    [
      stepId,
      input.runId,
      input.definition.key,
      input.position,
      input.definition.kind,
      input.definition.handler,
      input.definition.kind === "TOOL" ? input.definition.effectClass : "PURE",
      input.definition.kind === "TOOL" ? input.definition.toolVersion : "1",
      waitingForApproval ? "WAITING_APPROVAL" : "READY",
      JSON.stringify(input.stepInput),
      input.policy.maxAttempts,
      input.policy.initialBackoffMs,
      input.policy.multiplier,
      input.policy.maxBackoffMs,
    ],
  );

  if (input.definition.kind === "APPROVAL") {
    const approvalId = randomUUID();
    const payload = input.stepInput;
    const proposal = { stepKey: input.definition.key, payload };
    await transaction.query(
      `INSERT INTO approvals
       (id, run_id, step_id, generation, status, proposal_json, proposal_hash,
          payload_json, payload_hash, reviewer_role, expires_at)
       VALUES ($1, $2, $3, 1, 'PENDING', $4::jsonb, $5, $6::jsonb, $7, $8,
         now() + ($9 * interval '1 millisecond'))`,
      [
        approvalId,
        input.runId,
        stepId,
        JSON.stringify(proposal),
        hash(proposal),
        JSON.stringify(payload),
        hash(payload),
        input.definition.reviewerRole,
        input.definition.expiresAfterMs,
      ],
    );
    await transaction.query(
      "UPDATE workflow_runs SET wait_reason = 'APPROVAL' WHERE id = $1",
      [input.runId],
    );
    return { stepId, approvalId };
  }

  if (input.control === "RUN") {
    const job: OperationJob = {
      runId: input.runId,
      operationId: stepId,
      workflowVersionId: input.workflowVersionId,
      dispatchGeneration: 1,
    };
    await transaction.query(
      `INSERT INTO outbox (id, run_id, step_id, generation, kind, payload_json)
       VALUES ($1, $2, $3, 1, 'DISPATCH_OPERATION', $4::jsonb)`,
      [randomUUID(), input.runId, stepId, JSON.stringify(job)],
    );
  }
  return { stepId, approvalId: null };
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
        const checkpointId = randomUUID();
        const eventId = randomUUID();

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
        const first = await materializeStep(transaction, {
          runId,
          workflowVersionId: input.workflowVersionId,
          position: 0,
          definition: firstDefinition,
          stepInput: input.input,
          policy: retryPolicy,
          control: "RUN",
        });
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
          `INSERT INTO audit_events
             (id, run_id, sequence, step_id, type, payload_json)
           VALUES ($1, $2, 1, $3, 'RUN_CREATED', $4::jsonb)`,
          [
            eventId,
            runId,
            first.stepId,
            JSON.stringify({
              checkpointId,
              workflowVersionId: input.workflowVersionId,
              approvalId: first.approvalId,
            }),
          ],
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
         effect_class AS "effectClass", tool_version AS "toolVersion",
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
        : run.waitReason === "RECONCILIATION"
          ? "NEEDS_ATTENTION"
          : run.waitReason === "APPROVAL"
          ? "WAITING_APPROVAL"
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

export async function getRunApprovals(database: Queryable, runId: string) {
  const exists = await database.query("SELECT 1 FROM workflow_runs WHERE id = $1", [runId]);
  if (exists.rowCount === 0) throw new NotFoundError("Run not found");
  const approvals = await database.query(
    `SELECT id, run_id AS "runId", step_id AS "stepId", generation, status,
       proposal_json AS proposal, proposal_hash AS "proposalHash",
       payload_json AS payload, payload_hash AS "payloadHash",
       reviewer_role AS "reviewerRole", expires_at AS "expiresAt",
       decision, decision_at AS "decisionAt", decided_by AS "decidedBy",
       decided_role AS "decidedRole", decision_request_id AS "decisionRequestId",
       created_at AS "createdAt"
     FROM approvals WHERE run_id = $1 ORDER BY created_at, id`,
    [runId],
  );
  return approvals.rows;
}

export async function getRunToolExecutions(database: Queryable, runId: string) {
  const exists = await database.query("SELECT 1 FROM workflow_runs WHERE id = $1", [runId]);
  if (exists.rowCount === 0) throw new NotFoundError("Run not found");
  const executions = await database.query(
    `SELECT te.id, te.run_id AS "runId", te.step_id AS "stepId",
       te.attempt_id AS "attemptId", te.effect_ordinal AS "effectOrdinal",
       te.tool_name AS "toolName", te.tool_version AS "toolVersion",
       te.effect_class AS "effectClass", te.request_hash AS "requestHash",
       te.idempotency_record_id AS "idempotencyRecordId",
       ir.idempotency_key AS "idempotencyKey", ir.status AS "idempotencyStatus",
       te.invocation_status AS "invocationStatus", te.receiver_id AS "receiverId",
       te.receipt_json AS receipt, te.sent_at AS "sentAt",
       te.completed_at AS "completedAt", te.created_at AS "createdAt"
     FROM tool_executions te
     JOIN idempotency_records ir ON ir.id = te.idempotency_record_id
     WHERE te.run_id = $1 ORDER BY te.created_at, te.id`,
    [runId],
  );
  return executions.rows;
}

export async function reconcileToolExecution(
  database: Database,
  toolExecutionId: string,
  decision: ReconciliationDecision,
) {
  return withTransaction(database, async (transaction) => {
    const locked = await transaction.query<{
      run_id: string;
      lifecycle: string;
      control: string;
      wait_reason: string;
      state_revision: number;
      current_checkpoint_id: string;
      workflow_version_id: string;
      definition_json: WorkflowDefinition;
      step_id: string;
      position: number;
      step_status: string;
      idempotency_record_id: string;
      invocation_status: string;
      max_attempts: number;
      retry_initial_ms: number;
      retry_multiplier: number;
      retry_cap_ms: number;
    }>(
      `SELECT wr.id AS run_id, wr.lifecycle, wr.control, wr.wait_reason,
         wr.state_revision, wr.current_checkpoint_id, wr.workflow_version_id,
         wv.definition_json, ws.id AS step_id, ws.position, ws.status AS step_status,
         ws.max_attempts, ws.retry_initial_ms, ws.retry_multiplier, ws.retry_cap_ms,
         te.idempotency_record_id, te.invocation_status
       FROM tool_executions te
       JOIN workflow_steps ws ON ws.id = te.step_id
       JOIN workflow_runs wr ON wr.id = ws.run_id
       JOIN workflow_versions wv ON wv.id = wr.workflow_version_id
       WHERE te.id = $1 FOR UPDATE OF wr`,
      [toolExecutionId],
    );
    const row = locked.rows[0];
    if (!row) throw new NotFoundError("Tool execution not found");
    if (
      row.lifecycle !== "OPEN" || row.wait_reason !== "RECONCILIATION" ||
      row.step_status !== "UNKNOWN" || row.invocation_status !== "UNKNOWN"
    ) {
      throw new ConflictError("Tool execution is not awaiting reconciliation");
    }
    await transaction.query("SELECT 1 FROM workflow_steps WHERE id = $1 FOR UPDATE", [row.step_id]);
    await transaction.query("SELECT 1 FROM idempotency_records WHERE id = $1 FOR UPDATE", [row.idempotency_record_id]);
    await transaction.query("SELECT 1 FROM tool_executions WHERE id = $1 FOR UPDATE", [toolExecutionId]);

    if (decision.resolution === "FAIL_FINAL") {
      const failure = { code: "EFFECT_RECONCILED_FAILED", toolExecutionId };
      await transaction.query(
        `UPDATE tool_executions SET invocation_status = 'FAILED', completed_at = now()
         WHERE id = $1`,
        [toolExecutionId],
      );
      await transaction.query(
        `UPDATE idempotency_records SET status = 'FAILED_FINAL', updated_at = now()
         WHERE id = $1`,
        [row.idempotency_record_id],
      );
      await transaction.query(
        `UPDATE workflow_steps SET status = 'FAILED', completed_at = now(),
           failure_json = $1::jsonb WHERE id = $2`,
        [JSON.stringify(failure), row.step_id],
      );
      await transaction.query(
        `UPDATE workflow_runs SET lifecycle = 'FAILED', wait_reason = 'NONE',
           failure_json = $1::jsonb, finished_at = now() WHERE id = $2`,
        [JSON.stringify(failure), row.run_id],
      );
      const sequence = await nextEventSequence(transaction, row.run_id);
      await transaction.query(
        `INSERT INTO audit_events (id, run_id, sequence, step_id, type, payload_json)
         VALUES ($1, $2, $3, $4, 'EFFECT_RECONCILED_FAILED', $5::jsonb)`,
        [randomUUID(), row.run_id, sequence, row.step_id, JSON.stringify(failure)],
      );
      return getRun(transaction, row.run_id);
    }

    const output = {
      published: true,
      receiverId: decision.receiverId!,
      receipt: decision.receipt!,
      reconciled: true,
    };
    await transaction.query(
      `UPDATE tool_executions SET invocation_status = 'SUCCEEDED', receiver_id = $1,
         receipt_json = $2::jsonb, completed_at = now() WHERE id = $3`,
      [decision.receiverId, JSON.stringify(decision.receipt), toolExecutionId],
    );
    await transaction.query(
      `UPDATE idempotency_records SET status = 'SUCCEEDED', result_json = $1::jsonb,
         receipt_json = $2::jsonb, updated_at = now() WHERE id = $3`,
      [JSON.stringify(output), JSON.stringify(decision.receipt), row.idempotency_record_id],
    );
    await transaction.query(
      `UPDATE workflow_steps SET status = 'SUCCEEDED', accepted_output_json = $1::jsonb,
         completed_at = now(), failure_json = NULL WHERE id = $2`,
      [JSON.stringify(output), row.step_id],
    );

    const definition = workflowDefinitionSchema.parse(row.definition_json);
    const nextDefinition = definition.steps[row.position + 1];
    let successorId: string | null = null;
    let successorApprovalId: string | null = null;
    if (nextDefinition) {
      const successor = await materializeStep(transaction, {
        runId: row.run_id,
        workflowVersionId: row.workflow_version_id,
        position: row.position + 1,
        definition: nextDefinition,
        stepInput: output,
        policy: {
          maxAttempts: row.max_attempts,
          initialBackoffMs: row.retry_initial_ms,
          multiplier: row.retry_multiplier,
          maxBackoffMs: row.retry_cap_ms,
        },
        control: row.control,
      });
      successorId = successor.stepId;
      successorApprovalId = successor.approvalId;
    }
    const checkpointId = randomUUID();
    const revision = row.state_revision + 1;
    await transaction.query(
      `INSERT INTO checkpoints
         (id, run_id, revision, parent_id, workflow_version_id, cursor, reason, snapshot_json)
       VALUES ($1, $2, $3, $4, $5, $6, 'EFFECT_RECONCILED_SUCCEEDED', $7::jsonb)`,
      [
        checkpointId,
        row.run_id,
        revision,
        row.current_checkpoint_id,
        row.workflow_version_id,
        nextDefinition?.key ?? null,
        JSON.stringify({ toolExecutionId, receiverId: decision.receiverId, successorId }),
      ],
    );
    if (nextDefinition) {
      await transaction.query(
        `UPDATE workflow_runs SET current_checkpoint_id = $1, state_revision = $2,
           wait_reason = $3 WHERE id = $4`,
        [checkpointId, revision, successorApprovalId ? "APPROVAL" : "NONE", row.run_id],
      );
    } else {
      await transaction.query(
        `UPDATE workflow_runs SET current_checkpoint_id = $1, state_revision = $2,
           lifecycle = 'SUCCEEDED', wait_reason = 'NONE', finished_at = now()
         WHERE id = $3`,
        [checkpointId, revision, row.run_id],
      );
    }
    const sequence = await nextEventSequence(transaction, row.run_id);
    await transaction.query(
      `INSERT INTO audit_events (id, run_id, sequence, step_id, type, payload_json)
       VALUES ($1, $2, $3, $4, 'EFFECT_RECONCILED_SUCCEEDED', $5::jsonb)`,
      [
        randomUUID(),
        row.run_id,
        sequence,
        row.step_id,
        JSON.stringify({ toolExecutionId, receiverId: decision.receiverId, checkpointId, successorId }),
      ],
    );
    return getRun(transaction, row.run_id);
  });
}

export async function decideApproval(
  database: Database,
  approvalId: string,
  decision: ApprovalDecision,
  reviewer: { id: string; role: string },
) {
  const outcome = await withTransaction(database, async (transaction) => {
    const target = await transaction.query<{
      run_id: string;
      lifecycle: string;
      control: string;
      deadline_valid: boolean;
      state_revision: number;
      current_checkpoint_id: string;
      workflow_version_id: string;
      definition_json: WorkflowDefinition;
      step_id: string;
      position: number;
      max_attempts: number;
      retry_initial_ms: number;
      retry_multiplier: number;
      retry_cap_ms: number;
    }>(
      `SELECT wr.id AS run_id, wr.lifecycle, wr.control,
         (wr.deadline_at > now()) AS deadline_valid, wr.state_revision,
         wr.current_checkpoint_id, wr.workflow_version_id, wv.definition_json,
         a.step_id, ws.position, ws.max_attempts, ws.retry_initial_ms,
         ws.retry_multiplier, ws.retry_cap_ms
       FROM approvals a
       JOIN workflow_runs wr ON wr.id = a.run_id
       JOIN workflow_versions wv ON wv.id = wr.workflow_version_id
       JOIN workflow_steps ws ON ws.id = a.step_id
       WHERE a.id = $1
       FOR UPDATE OF wr`,
      [approvalId],
    );
    const run = target.rows[0];
    if (!run) throw new NotFoundError("Approval not found");

    const replay = await transaction.query<{
      id: string;
      decision: string | null;
      proposal_hash: string;
      payload_hash: string;
      decided_by: string | null;
      decided_role: string | null;
    }>(
      `SELECT id, decision, proposal_hash, payload_hash, decided_by, decided_role
       FROM approvals WHERE decision_request_id = $1 FOR UPDATE`,
      [decision.decisionRequestId],
    );
    const replayRow = replay.rows[0];
    if (replayRow) {
      if (
        replayRow.id !== approvalId ||
        replayRow.decision !== decision.decision ||
        replayRow.proposal_hash !== decision.proposalHash ||
        replayRow.payload_hash !== decision.payloadHash ||
        replayRow.decided_by !== reviewer.id ||
        replayRow.decided_role !== reviewer.role
      ) {
        throw new ConflictError("Decision request ID is already bound to a different decision");
      }
      return { kind: "accepted" as const, runId: run.run_id, replayed: true };
    }

    const approvalResult = await transaction.query<{
      status: string;
      proposal_hash: string;
      payload_hash: string;
      payload_json: Record<string, unknown>;
      reviewer_role: string;
      unexpired: boolean;
    }>(
      `SELECT status, proposal_hash, payload_hash, payload_json, reviewer_role,
         (expires_at > now()) AS unexpired
       FROM approvals WHERE id = $1 FOR UPDATE`,
      [approvalId],
    );
    const approval = approvalResult.rows[0]!;
    if (run.lifecycle !== "OPEN") throw new ConflictError("Terminal run cannot accept approval decisions");
    if (approval.status !== "PENDING") throw new ConflictError("Approval has already been resolved");
    if (approval.reviewer_role !== reviewer.role) {
      throw new ConflictError("Reviewer role is not authorized for this approval");
    }
    if (
      approval.proposal_hash !== decision.proposalHash ||
      approval.payload_hash !== decision.payloadHash
    ) {
      throw new ConflictError("Approval hashes do not match the persisted proposal and payload");
    }
    if (!run.deadline_valid) {
      const failure = { code: "RUN_DEADLINE_EXCEEDED" };
      await transaction.query(
        "UPDATE approvals SET status = 'CANCELLED', decision_at = now() WHERE id = $1",
        [approvalId],
      );
      await transaction.query(
        `UPDATE workflow_steps SET status = 'FAILED', completed_at = now(),
           failure_json = $1::jsonb WHERE id = $2 AND status = 'WAITING_APPROVAL'`,
        [JSON.stringify(failure), run.step_id],
      );
      await transaction.query(
        `UPDATE workflow_runs SET lifecycle = 'TIMED_OUT', wait_reason = 'NONE',
           failure_json = $1::jsonb, finished_at = now() WHERE id = $2`,
        [JSON.stringify(failure), run.run_id],
      );
      const sequence = await nextEventSequence(transaction, run.run_id);
      await transaction.query(
        `INSERT INTO audit_events (id, run_id, sequence, step_id, type, payload_json)
         VALUES ($1, $2, $3, $4, 'RUN_TIMED_OUT', $5::jsonb)`,
        [randomUUID(), run.run_id, sequence, run.step_id, JSON.stringify(failure)],
      );
      return { kind: "timedOut" as const };
    }
    if (!approval.unexpired) {
      const failure = { code: "APPROVAL_EXPIRED", approvalId };
      await transaction.query(
        "UPDATE approvals SET status = 'EXPIRED', decision_at = now() WHERE id = $1",
        [approvalId],
      );
      await transaction.query(
        `UPDATE workflow_steps SET status = 'FAILED', completed_at = now(),
           failure_json = $1::jsonb WHERE id = $2 AND status = 'WAITING_APPROVAL'`,
        [JSON.stringify(failure), run.step_id],
      );
      await transaction.query(
        `UPDATE workflow_runs SET lifecycle = 'FAILED', wait_reason = 'NONE',
           failure_json = $1::jsonb, finished_at = now() WHERE id = $2`,
        [JSON.stringify(failure), run.run_id],
      );
      const sequence = await nextEventSequence(transaction, run.run_id);
      await transaction.query(
        `INSERT INTO audit_events (id, run_id, sequence, step_id, type, payload_json)
         VALUES ($1, $2, $3, $4, 'APPROVAL_EXPIRED', $5::jsonb)`,
        [randomUUID(), run.run_id, sequence, run.step_id, JSON.stringify(failure)],
      );
      return { kind: "expired" as const };
    }

    const approvalStatus = decision.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    await transaction.query(
      `UPDATE approvals SET status = $1, decision = $2, decision_at = now(),
         decided_by = $3, decided_role = $4, decision_request_id = $5
       WHERE id = $6`,
      [approvalStatus, decision.decision, reviewer.id, reviewer.role, decision.decisionRequestId, approvalId],
    );

    if (decision.decision === "REJECT") {
      const failure = { code: "APPROVAL_REJECTED", approvalId, reviewerId: reviewer.id };
      await transaction.query(
        `UPDATE workflow_steps SET status = 'FAILED', completed_at = now(),
           failure_json = $1::jsonb WHERE id = $2`,
        [JSON.stringify(failure), run.step_id],
      );
      await transaction.query(
        `UPDATE workflow_runs SET lifecycle = 'FAILED', wait_reason = 'NONE',
           failure_json = $1::jsonb, finished_at = now() WHERE id = $2`,
        [JSON.stringify(failure), run.run_id],
      );
      const sequence = await nextEventSequence(transaction, run.run_id);
      await transaction.query(
        `INSERT INTO audit_events (id, run_id, sequence, step_id, type, payload_json)
         VALUES ($1, $2, $3, $4, 'APPROVAL_REJECTED', $5::jsonb)`,
        [randomUUID(), run.run_id, sequence, run.step_id, JSON.stringify(failure)],
      );
      return { kind: "accepted" as const, runId: run.run_id, replayed: false };
    }

    await transaction.query(
      `UPDATE workflow_steps SET status = 'SUCCEEDED', accepted_output_json = $1::jsonb,
         completed_at = now(), failure_json = NULL WHERE id = $2`,
      [JSON.stringify(approval.payload_json), run.step_id],
    );
    const definition = workflowDefinitionSchema.parse(run.definition_json);
    const nextDefinition = definition.steps[run.position + 1];
    let successorId: string | null = null;
    let successorApprovalId: string | null = null;
    if (nextDefinition) {
      const successor = await materializeStep(transaction, {
        runId: run.run_id,
        workflowVersionId: run.workflow_version_id,
        position: run.position + 1,
        definition: nextDefinition,
        stepInput: approval.payload_json,
        policy: {
          maxAttempts: run.max_attempts,
          initialBackoffMs: run.retry_initial_ms,
          multiplier: run.retry_multiplier,
          maxBackoffMs: run.retry_cap_ms,
        },
        control: run.control,
      });
      successorId = successor.stepId;
      successorApprovalId = successor.approvalId;
    }

    const checkpointId = randomUUID();
    const revision = run.state_revision + 1;
    await transaction.query(
      `INSERT INTO checkpoints
         (id, run_id, revision, parent_id, workflow_version_id, cursor, reason, snapshot_json)
       VALUES ($1, $2, $3, $4, $5, $6, 'APPROVAL_APPROVED', $7::jsonb)`,
      [
        checkpointId,
        run.run_id,
        revision,
        run.current_checkpoint_id,
        run.workflow_version_id,
        nextDefinition?.key ?? null,
        JSON.stringify({ approvalId, reviewerId: reviewer.id, successorId, successorApprovalId }),
      ],
    );
    if (nextDefinition) {
      await transaction.query(
        `UPDATE workflow_runs SET current_checkpoint_id = $1, state_revision = $2,
           wait_reason = $3 WHERE id = $4`,
        [checkpointId, revision, successorApprovalId ? "APPROVAL" : "NONE", run.run_id],
      );
    } else {
      await transaction.query(
        `UPDATE workflow_runs SET current_checkpoint_id = $1, state_revision = $2,
           lifecycle = 'SUCCEEDED', wait_reason = 'NONE', finished_at = now()
         WHERE id = $3`,
        [checkpointId, revision, run.run_id],
      );
    }
    const sequence = await nextEventSequence(transaction, run.run_id);
    await transaction.query(
      `INSERT INTO audit_events (id, run_id, sequence, step_id, type, payload_json)
       VALUES ($1, $2, $3, $4, 'APPROVAL_APPROVED', $5::jsonb)`,
      [
        randomUUID(),
        run.run_id,
        sequence,
        run.step_id,
        JSON.stringify({ approvalId, reviewerId: reviewer.id, checkpointId, successorId }),
      ],
    );
    return { kind: "accepted" as const, runId: run.run_id, replayed: false };
  });

  if (outcome.kind === "expired") throw new ConflictError("Approval has expired");
  if (outcome.kind === "timedOut") throw new ConflictError("Run deadline has expired");
  return {
    replayed: outcome.replayed,
    run: await getRun(database, outcome.runId),
    approvals: await getRunApprovals(database, outcome.runId),
  };
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
  kind: string;
  handler: string;
  effectClass: string;
  toolVersion: string;
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
      kind: string;
      handler: string;
      effect_class: string;
      tool_version: string;
      position: number;
      input_json: Record<string, unknown>;
    }>(
      `SELECT wr.id AS run_id, ws.id AS operation_id,
         wr.workflow_version_id, wr.lifecycle, wr.control, wr.wait_reason,
         (wr.deadline_at > now()) AS deadline_valid, ws.status,
         ws.dispatch_generation, ws.attempt_count, ws.lease_epoch,
         ws.node_key, ws.kind, ws.handler, ws.effect_class, ws.tool_version,
         ws.position, ws.input_json
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
      kind: row.kind,
      handler: row.handler,
      effectClass: row.effect_class,
      toolVersion: row.tool_version,
      position: row.position,
      input: row.input_json,
    };
  });
}

export interface PreparedToolExecution {
  toolExecutionId: string;
  idempotencyRecordId: string;
  key: string;
  requestHash: string;
  effectClass: string;
  receiverNamespace: string;
}

const controlledPublicationNamespace = "controlled-publication-v1";

export async function prepareToolExecution(
  database: Database,
  operation: ClaimedOperation,
): Promise<PreparedToolExecution> {
  if (operation.kind !== "TOOL") throw new ConflictError("Operation is not a tool step");
  return withTransaction(database, async (transaction) => {
    const locked = await transaction.query<{
      lifecycle: string;
      control: string;
      deadline_valid: boolean;
      status: string;
      lease_owner: string | null;
      lease_epoch: number;
      lease_valid: boolean;
      attempt_status: string;
    }>(
      `SELECT wr.lifecycle, wr.control, (wr.deadline_at > now()) AS deadline_valid,
         ws.status, ws.lease_owner, ws.lease_epoch,
         (ws.lease_expires_at > now()) AS lease_valid, sa.status AS attempt_status
       FROM workflow_runs wr
       JOIN workflow_steps ws ON ws.run_id = wr.id
       JOIN step_attempts sa ON sa.step_id = ws.id
       WHERE wr.id = $1 AND ws.id = $2 AND sa.id = $3
       FOR UPDATE OF wr, ws, sa`,
      [operation.runId, operation.operationId, operation.attemptId],
    );
    const row = locked.rows[0];
    if (
      !row || row.lifecycle !== "OPEN" || row.control !== "RUN" || !row.deadline_valid ||
      row.status !== "RUNNING" || row.lease_owner !== operation.workerId ||
      row.lease_epoch !== operation.leaseEpoch || !row.lease_valid ||
      row.attempt_status !== "RUNNING"
    ) {
      throw new ConflictError("Tool invocation rejected by lease fencing");
    }

    const requestHash = hash(operation.input);
    const key = `agentflow:${operation.runId}:${operation.operationId}:0`;
    const scope = `run:${operation.runId}`;
    const recordId = randomUUID();
    await transaction.query(
      `INSERT INTO idempotency_records
         (id, run_id, operation_id, effect_ordinal, scope, tool_namespace,
          idempotency_key, request_hash, status, receiver_account, retention_until)
       VALUES ($1, $2, $3, 0, $4, $5, $6, $7, 'PREPARED', 'controlled',
         now() + interval '30 days')
       ON CONFLICT (operation_id, effect_ordinal) DO NOTHING`,
      [recordId, operation.runId, operation.operationId, scope, controlledPublicationNamespace, key, requestHash],
    );
    const recordResult = await transaction.query<{
      id: string;
      request_hash: string;
      idempotency_key: string;
      tool_namespace: string;
      status: string;
    }>(
      `SELECT id, request_hash, idempotency_key, tool_namespace, status
       FROM idempotency_records WHERE operation_id = $1 AND effect_ordinal = 0
       FOR UPDATE`,
      [operation.operationId],
    );
    const record = recordResult.rows[0]!;
    if (
      record.request_hash !== requestHash || record.idempotency_key !== key ||
      record.tool_namespace !== controlledPublicationNamespace
    ) {
      throw new ConflictError("Stable tool identity is bound to different request data");
    }
    if (record.status === "SUCCEEDED" || record.status === "FAILED_FINAL" || record.status === "UNKNOWN") {
      throw new ConflictError(`Tool identity is already ${record.status}`);
    }
    if (operation.effectClass === "UNSAFE_WRITE" && record.status === "IN_FLIGHT") {
      const prior = await transaction.query(
        "SELECT 1 FROM tool_executions WHERE idempotency_record_id = $1 AND attempt_id <> $2 LIMIT 1",
        [record.id, operation.attemptId],
      );
      if (prior.rowCount !== 0) {
        throw new ConflictError("Unsafe tool outcome must be reconciled before another send");
      }
    }

    const toolExecutionId = randomUUID();
    await transaction.query(
      `INSERT INTO tool_executions
         (id, run_id, step_id, attempt_id, effect_ordinal, tool_name, tool_version,
          effect_class, request_hash, idempotency_record_id, invocation_status)
       VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9, 'PREPARED')
       ON CONFLICT (attempt_id, effect_ordinal) DO NOTHING`,
      [
        toolExecutionId,
        operation.runId,
        operation.operationId,
        operation.attemptId,
        operation.handler,
        operation.toolVersion,
        operation.effectClass,
        requestHash,
        record.id,
      ],
    );
    const execution = await transaction.query<{ id: string; request_hash: string; invocation_status: string }>(
      `SELECT id, request_hash, invocation_status FROM tool_executions
       WHERE attempt_id = $1 AND effect_ordinal = 0 FOR UPDATE`,
      [operation.attemptId],
    );
    const executionRow = execution.rows[0]!;
    if (executionRow.request_hash !== requestHash || executionRow.invocation_status !== "PREPARED") {
      throw new ConflictError("Tool attempt has already left its prepared state");
    }
    await transaction.query(
      `UPDATE idempotency_records SET status = 'IN_FLIGHT',
         first_sent_at = COALESCE(first_sent_at, now()), updated_at = now()
       WHERE id = $1`,
      [record.id],
    );
    await transaction.query(
      `UPDATE tool_executions SET invocation_status = 'IN_FLIGHT', sent_at = now()
       WHERE id = $1`,
      [executionRow.id],
    );
    return {
      toolExecutionId: executionRow.id,
      idempotencyRecordId: record.id,
      key,
      requestHash,
      effectClass: operation.effectClass,
      receiverNamespace: controlledPublicationNamespace,
    };
  });
}

export async function publishToControlledReceiver(
  database: Database,
  intent: PreparedToolExecution,
  payload: Record<string, unknown>,
) {
  if (hash(payload) !== intent.requestHash) {
    throw new ConflictError("Receiver payload does not match the prepared tool request");
  }
  return withTransaction(database, async (transaction) => {
    const receiverId = randomUUID();
    const receipt = { receiverId, status: "ACCEPTED" };
    const idempotencyKey = intent.effectClass === "RECEIVER_IDEMPOTENT_WRITE" ? intent.key : null;
    if (idempotencyKey) {
      await transaction.query(
        `INSERT INTO controlled_publication_effects
           (id, receiver_namespace, idempotency_key, request_hash, payload_json, receipt_json)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         ON CONFLICT (receiver_namespace, idempotency_key)
           WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [
          receiverId,
          intent.receiverNamespace,
          idempotencyKey,
          intent.requestHash,
          JSON.stringify(payload),
          JSON.stringify(receipt),
        ],
      );
      const persisted = await transaction.query<{
        id: string;
        request_hash: string;
        receipt_json: Record<string, unknown>;
      }>(
        `SELECT id, request_hash, receipt_json FROM controlled_publication_effects
         WHERE receiver_namespace = $1 AND idempotency_key = $2 FOR UPDATE`,
        [intent.receiverNamespace, idempotencyKey],
      );
      const row = persisted.rows[0]!;
      if (row.request_hash !== intent.requestHash) {
        throw new ConflictError("Receiver idempotency key is bound to a different request");
      }
      return { receiverId: row.id, receipt: row.receipt_json, replayed: row.id !== receiverId };
    }

    await transaction.query(
      `INSERT INTO controlled_publication_effects
         (id, receiver_namespace, idempotency_key, request_hash, payload_json, receipt_json)
       VALUES ($1, $2, NULL, $3, $4::jsonb, $5::jsonb)`,
      [receiverId, intent.receiverNamespace, intent.requestHash, JSON.stringify(payload), JSON.stringify(receipt)],
    );
    return { receiverId, receipt, replayed: false };
  });
}

export async function executeToolOperation(
  database: Database,
  operation: ClaimedOperation,
): Promise<Record<string, unknown>> {
  if (operation.handler !== "publish-report") {
    throw new PermanentOperationError(`Unsupported tool handler: ${operation.handler}`);
  }
  const intent = await prepareToolExecution(database, operation);
  let result: Awaited<ReturnType<typeof publishToControlledReceiver>>;
  try {
    result = await publishToControlledReceiver(database, intent, operation.input);
  } catch (error) {
    if (error instanceof ConflictError) {
      throw new PermanentOperationError(error.message, "TOOL_IDENTITY_CONFLICT");
    }
    if (operation.effectClass === "UNSAFE_WRITE" || operation.effectClass === "RECONCILIABLE_WRITE") {
      throw new UnknownEffectError("Receiver outcome is ambiguous", error);
    }
    throw new RetryableOperationError("Receiver request did not produce a confirmed result", "RECEIVER_UNAVAILABLE");
  }
  return {
    published: true,
    receiverId: result.receiverId,
    receipt: result.receipt,
    receiverReplayed: result.replayed,
  };
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

export class UnknownEffectError extends Error {
  constructor(message: string, readonly causeValue?: unknown) {
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
    `UPDATE tool_executions SET invocation_status = 'UNKNOWN', completed_at = now()
     WHERE attempt_id = $1 AND invocation_status = 'IN_FLIGHT'`,
    [operation.attemptId],
  );
  await transaction.query(
    `UPDATE idempotency_records SET status = 'UNKNOWN', updated_at = now()
     WHERE operation_id = $1 AND status = 'IN_FLIGHT'`,
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

export async function settleUnknownToolOutcome(
  database: Database,
  operation: ClaimedOperation,
  error: UnknownEffectError,
) {
  return withTransaction(database, async (transaction) => {
    const locked = await transaction.query<{
      lifecycle: string;
      control: string;
      deadline_valid: boolean;
      status: string;
      lease_owner: string | null;
      lease_epoch: number;
      lease_valid: boolean;
    }>(
      `SELECT wr.lifecycle, wr.control, (wr.deadline_at > now()) AS deadline_valid,
         ws.status, ws.lease_owner, ws.lease_epoch,
         (ws.lease_expires_at > now()) AS lease_valid
       FROM workflow_runs wr JOIN workflow_steps ws ON ws.run_id = wr.id
       WHERE wr.id = $1 AND ws.id = $2 FOR UPDATE OF wr, ws`,
      [operation.runId, operation.operationId],
    );
    const row = locked.rows[0];
    if (
      !row || row.lifecycle !== "OPEN" || row.status !== "RUNNING" ||
      row.lease_owner !== operation.workerId || row.lease_epoch !== operation.leaseEpoch ||
      !row.lease_valid
    ) {
      throw new ConflictError("Unknown tool outcome rejected by lease fencing");
    }
    if (row.control === "CANCEL_REQUESTED") {
      return cancelLockedOperation(transaction, operation);
    }
    const failure = {
      code: "EFFECT_OUTCOME_UNKNOWN",
      effectClass: operation.effectClass,
      message: error.message.slice(0, 1_000),
    };
    await transaction.query(
      `UPDATE step_attempts SET status = 'FAILED', finished_at = now(),
         error_class = 'TIMEOUT', retryable = false, error_json = $1::jsonb
       WHERE id = $2 AND status = 'RUNNING'`,
      [JSON.stringify(failure), operation.attemptId],
    );
    await transaction.query(
      `UPDATE tool_executions SET invocation_status = 'UNKNOWN', completed_at = now()
       WHERE attempt_id = $1 AND invocation_status = 'IN_FLIGHT'`,
      [operation.attemptId],
    );
    await transaction.query(
      `UPDATE idempotency_records SET status = 'UNKNOWN', updated_at = now()
       WHERE operation_id = $1 AND status = 'IN_FLIGHT'`,
      [operation.operationId],
    );
    await transaction.query(
      `UPDATE workflow_steps SET status = 'UNKNOWN', lease_owner = NULL,
         lease_expires_at = NULL, next_attempt_at = NULL, failure_json = $1::jsonb
       WHERE id = $2`,
      [JSON.stringify(failure), operation.operationId],
    );
    if (row.deadline_valid) {
      await transaction.query(
        `UPDATE workflow_runs SET wait_reason = 'RECONCILIATION',
           control = CASE WHEN control = 'PAUSE_REQUESTED' THEN 'PAUSED' ELSE control END
         WHERE id = $1`,
        [operation.runId],
      );
    } else {
      await transaction.query(
        `UPDATE workflow_runs SET lifecycle = 'TIMED_OUT', wait_reason = 'NONE',
           failure_json = jsonb_build_object('code', 'RUN_DEADLINE_EXCEEDED'),
           finished_at = now() WHERE id = $1`,
        [operation.runId],
      );
    }
    const sequence = await nextEventSequence(transaction, operation.runId);
    await transaction.query(
      `INSERT INTO audit_events
         (id, run_id, sequence, step_id, attempt_id, type, payload_json)
       VALUES ($1, $2, $3, $4, $5, 'EFFECT_OUTCOME_UNKNOWN', $6::jsonb)`,
      [
        randomUUID(),
        operation.runId,
        sequence,
        operation.operationId,
        operation.attemptId,
        JSON.stringify(failure),
      ],
    );
    return { unknown: true, timedOut: !row.deadline_valid };
  });
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
        `UPDATE tool_executions SET invocation_status = 'UNKNOWN', completed_at = now()
         WHERE attempt_id = $1 AND invocation_status = 'IN_FLIGHT'`,
        [operation.attemptId],
      );
      await transaction.query(
        `UPDATE idempotency_records SET status = 'UNKNOWN', updated_at = now()
         WHERE operation_id = $1 AND status = 'IN_FLIGHT'`,
        [operation.operationId],
      );
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
      await transaction.query(
        `UPDATE tool_executions SET invocation_status = 'ABANDONED', completed_at = now()
         WHERE attempt_id = $1 AND invocation_status = 'IN_FLIGHT'`,
        [operation.attemptId],
      );
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
      `UPDATE tool_executions SET invocation_status = 'UNKNOWN', completed_at = now()
       WHERE attempt_id = $1 AND invocation_status = 'IN_FLIGHT'`,
      [operation.attemptId],
    );
    await transaction.query(
      `UPDATE idempotency_records SET status = 'UNKNOWN', updated_at = now()
       WHERE operation_id = $1 AND status = 'IN_FLIGHT'`,
      [operation.operationId],
    );
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
       WHERE run_id = $1 AND status IN ('PENDING', 'READY', 'RUNNING', 'RETRY_WAIT', 'WAITING_APPROVAL')
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
           WHERE run_id = $1 AND status IN ('PENDING', 'READY', 'RETRY_WAIT', 'WAITING_APPROVAL')`,
          [runId],
        );
        await transaction.query(
          `UPDATE approvals SET status = 'CANCELLED', decision_at = now()
           WHERE run_id = $1 AND status = 'PENDING'`,
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
  expiredApprovals: number;
  expiredLeases: number;
  unknownEffects: number;
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
    let expiredApprovals = 0;
    let unknownEffects = 0;
    let recoveredDispatches = 0;
    let dueRetries = 0;
    let timedOutRuns = 0;
    let settledCancellations = 0;
    let failedOperations = 0;
    let timedOutAttempts = 0;

    const approvals = await transaction.query<{ id: string; run_id: string; step_id: string }>(
      `SELECT a.id, a.run_id, a.step_id
       FROM approvals a
       JOIN workflow_runs wr ON wr.id = a.run_id
       WHERE a.status = 'PENDING' AND a.expires_at <= now()
         AND wr.lifecycle = 'OPEN' AND wr.deadline_at > now()
       ORDER BY a.expires_at, a.id LIMIT $1
       FOR UPDATE OF wr, a SKIP LOCKED`,
      [batchSize],
    );
    for (const approval of approvals.rows) {
      const failure = { code: "APPROVAL_EXPIRED", approvalId: approval.id };
      await transaction.query(
        "UPDATE approvals SET status = 'EXPIRED', decision_at = now() WHERE id = $1",
        [approval.id],
      );
      await transaction.query(
        `UPDATE workflow_steps SET status = 'FAILED', completed_at = now(),
           failure_json = $1::jsonb WHERE id = $2 AND status = 'WAITING_APPROVAL'`,
        [JSON.stringify(failure), approval.step_id],
      );
      await transaction.query(
        `UPDATE workflow_runs SET lifecycle = 'FAILED', wait_reason = 'NONE',
           failure_json = $1::jsonb, finished_at = now() WHERE id = $2`,
        [JSON.stringify(failure), approval.run_id],
      );
      const sequence = await nextEventSequence(transaction, approval.run_id);
      await transaction.query(
        `INSERT INTO audit_events (id, run_id, sequence, step_id, type, payload_json)
         VALUES ($1, $2, $3, $4, 'APPROVAL_EXPIRED', $5::jsonb)`,
        [randomUUID(), approval.run_id, sequence, approval.step_id, JSON.stringify(failure)],
      );
      expiredApprovals += 1;
    }

    const timedOut = await transaction.query<{ id: string }>(
      `SELECT id FROM workflow_runs
       WHERE lifecycle = 'OPEN' AND deadline_at <= now()
       ORDER BY deadline_at, id LIMIT $1
       FOR UPDATE`,
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
         WHERE run_id = $1 AND status IN ('PENDING', 'READY', 'RUNNING', 'RETRY_WAIT', 'WAITING_APPROVAL')`,
        [run.id],
      );
      await transaction.query(
        `UPDATE approvals SET status = 'CANCELLED', decision_at = now()
         WHERE run_id = $1 AND status = 'PENDING'`,
        [run.id],
      );
      await transaction.query(
        `UPDATE tool_executions SET invocation_status = 'UNKNOWN', completed_at = now()
         WHERE run_id = $1 AND invocation_status = 'IN_FLIGHT'`,
        [run.id],
      );
      await transaction.query(
        `UPDATE idempotency_records SET status = 'UNKNOWN', updated_at = now()
         WHERE run_id = $1 AND status = 'IN_FLIGHT'`,
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
         WHERE run_id = $1 AND status IN ('PENDING', 'READY', 'RUNNING', 'RETRY_WAIT', 'WAITING_APPROVAL')`,
        [run.id],
      );
      await transaction.query(
        `UPDATE approvals SET status = 'CANCELLED', decision_at = now()
         WHERE run_id = $1 AND status = 'PENDING'`,
        [run.id],
      );
      await transaction.query(
        `UPDATE tool_executions SET invocation_status = 'UNKNOWN', completed_at = now()
         WHERE run_id = $1 AND invocation_status = 'IN_FLIGHT'`,
        [run.id],
      );
      await transaction.query(
        `UPDATE idempotency_records SET status = 'UNKNOWN', updated_at = now()
         WHERE run_id = $1 AND status = 'IN_FLIGHT'`,
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
      effect_class: string;
      tool_execution_id: string | null;
      idempotency_record_id: string | null;
    }>(
      `SELECT ws.id, ws.run_id, wr.control, ws.lease_epoch,
         ws.attempt_count, ws.max_attempts, ws.retry_initial_ms,
         ws.retry_multiplier, ws.retry_cap_ms,
         ws.effect_class,
         (SELECT sa.id FROM step_attempts sa
          WHERE sa.step_id = ws.id AND sa.epoch = ws.lease_epoch
          ORDER BY sa.started_at DESC LIMIT 1) AS attempt_id,
         (SELECT te.id FROM tool_executions te
          WHERE te.step_id = ws.id AND te.attempt_id = (
            SELECT sa.id FROM step_attempts sa
            WHERE sa.step_id = ws.id AND sa.epoch = ws.lease_epoch
            ORDER BY sa.started_at DESC LIMIT 1
          ) AND te.invocation_status = 'IN_FLIGHT'
          LIMIT 1) AS tool_execution_id,
         (SELECT te.idempotency_record_id FROM tool_executions te
          WHERE te.step_id = ws.id AND te.attempt_id = (
            SELECT sa.id FROM step_attempts sa
            WHERE sa.step_id = ws.id AND sa.epoch = ws.lease_epoch
            ORDER BY sa.started_at DESC LIMIT 1
          ) AND te.invocation_status = 'IN_FLIGHT'
          LIMIT 1) AS idempotency_record_id,
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
      const uncertainUnsafeEffect = row.tool_execution_id !== null &&
        (row.effect_class === "UNSAFE_WRITE" || row.effect_class === "RECONCILIABLE_WRITE");
      if (uncertainUnsafeEffect) {
        const failure = { code: "EFFECT_OUTCOME_UNKNOWN", effectClass: row.effect_class };
        await transaction.query(
          `UPDATE tool_executions SET invocation_status = 'UNKNOWN', completed_at = now()
           WHERE id = $1 AND invocation_status = 'IN_FLIGHT'`,
          [row.tool_execution_id],
        );
        await transaction.query(
          `UPDATE idempotency_records SET status = 'UNKNOWN', updated_at = now()
           WHERE id = $1 AND status = 'IN_FLIGHT'`,
          [row.idempotency_record_id],
        );
        await transaction.query(
          `UPDATE workflow_steps SET status = 'UNKNOWN', lease_owner = NULL,
             lease_expires_at = NULL, next_attempt_at = NULL, failure_json = $1::jsonb
           WHERE id = $2`,
          [JSON.stringify(failure), row.id],
        );
        await transaction.query(
          `UPDATE workflow_runs SET wait_reason = 'RECONCILIATION',
             control = CASE WHEN control = 'PAUSE_REQUESTED' THEN 'PAUSED' ELSE control END
           WHERE id = $1`,
          [row.run_id],
        );
        const sequence = await nextEventSequence(transaction, row.run_id);
        await transaction.query(
          `INSERT INTO audit_events
             (id, run_id, sequence, step_id, attempt_id, type, payload_json)
           VALUES ($1, $2, $3, $4, $5, 'EFFECT_OUTCOME_UNKNOWN', $6::jsonb)`,
          [randomUUID(), row.run_id, sequence, row.id, row.attempt_id, JSON.stringify(failure)],
        );
        unknownEffects += 1;
        if (row.attempt_timed_out) timedOutAttempts += 1;
        else expiredLeases += 1;
        continue;
      }
      if (row.tool_execution_id) {
        await transaction.query(
          `UPDATE tool_executions SET invocation_status = 'ABANDONED', completed_at = now()
           WHERE id = $1 AND invocation_status = 'IN_FLIGHT'`,
          [row.tool_execution_id],
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
      expiredApprovals,
      expiredLeases,
      unknownEffects,
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
        if (operation.kind === "TOOL") {
          const receiverId = output.receiverId;
          const receipt = output.receipt;
          if (
            typeof receiverId !== "string" || receiverId.length === 0 ||
            receipt === null || typeof receipt !== "object" || Array.isArray(receipt)
          ) {
            throw new ConflictError("Tool completion is missing receiver evidence");
          }
          const execution = await transaction.query<{ id: string; idempotency_record_id: string }>(
            `SELECT id, idempotency_record_id FROM tool_executions
             WHERE attempt_id = $1 AND step_id = $2 AND invocation_status = 'IN_FLIGHT'
             FOR UPDATE`,
            [operation.attemptId, operation.operationId],
          );
          const executionRow = execution.rows[0];
          if (!executionRow) throw new ConflictError("Tool invocation is no longer authoritative");
          await transaction.query(
            `UPDATE tool_executions SET invocation_status = 'SUCCEEDED', receiver_id = $1,
               receipt_json = $2::jsonb, completed_at = now() WHERE id = $3`,
            [receiverId, JSON.stringify(receipt), executionRow.id],
          );
          await transaction.query(
            `UPDATE idempotency_records SET status = 'SUCCEEDED', result_json = $1::jsonb,
               receipt_json = $2::jsonb, updated_at = now() WHERE id = $3`,
            [JSON.stringify(output), JSON.stringify(receipt), executionRow.idempotency_record_id],
          );
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
        let successorId: string | null = null;
        let approvalId: string | null = null;
        if (nextDefinition) {
          const successor = await materializeStep(transaction, {
            runId: operation.runId,
            workflowVersionId: row.workflow_version_id,
            position: row.position + 1,
            definition: nextDefinition,
            stepInput: output,
            policy: {
              maxAttempts: row.max_attempts,
              initialBackoffMs: row.retry_initial_ms,
              multiplier: row.retry_multiplier,
              maxBackoffMs: row.retry_cap_ms,
            },
            control: row.control === "PAUSE_REQUESTED" ? "PAUSED" : row.control,
          });
          successorId = successor.stepId;
          approvalId = successor.approvalId;
        }
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
              approvalId,
            }),
          ],
        );

        if (nextDefinition) {
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
            JSON.stringify({ checkpointId, successorId, approvalId }),
          ],
        );
        return { checkpointId, successorId, runCompleted: successorId === null };
      });
    } finally {
      span.end();
    }
  });
}
