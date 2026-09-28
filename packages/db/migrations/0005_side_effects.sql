ALTER TABLE workflow_steps
  DROP CONSTRAINT workflow_steps_kind_check,
  DROP CONSTRAINT workflow_steps_status_check;

ALTER TABLE workflow_steps
  ADD CONSTRAINT workflow_steps_kind_check
    CHECK (kind IN ('DETERMINISTIC', 'APPROVAL', 'TOOL')),
  ADD CONSTRAINT workflow_steps_status_check
    CHECK (status IN (
      'PENDING', 'READY', 'RUNNING', 'RETRY_WAIT', 'WAITING_APPROVAL',
      'UNKNOWN', 'SUCCEEDED', 'FAILED', 'CANCELLED'
    )),
  ADD COLUMN effect_class text NOT NULL DEFAULT 'PURE'
    CHECK (effect_class IN (
      'PURE', 'REPEATABLE_READ', 'RECEIVER_IDEMPOTENT_WRITE',
      'TRANSACTIONAL_LOCAL_WRITE', 'RECONCILIABLE_WRITE', 'UNSAFE_WRITE'
    )),
  ADD COLUMN tool_version text NOT NULL DEFAULT '1';

ALTER TABLE step_attempts
  ADD CONSTRAINT step_attempts_id_step_unique UNIQUE (id, step_id);

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  effect_ordinal integer NOT NULL DEFAULT 0 CHECK (effect_ordinal >= 0),
  scope text NOT NULL,
  tool_namespace text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('PREPARED', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED_FINAL', 'UNKNOWN')),
  receiver_account text NOT NULL,
  result_json jsonb,
  receipt_json jsonb,
  first_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  retention_until timestamptz NOT NULL,
  CONSTRAINT idempotency_operation_run_fk FOREIGN KEY (operation_id, run_id)
    REFERENCES workflow_steps(id, run_id) ON DELETE CASCADE,
  UNIQUE (operation_id, effect_ordinal),
  UNIQUE (scope, tool_namespace, idempotency_key),
  UNIQUE (id, operation_id)
);

CREATE INDEX idempotency_records_unresolved_idx
  ON idempotency_records (status, updated_at)
  WHERE status IN ('IN_FLIGHT', 'UNKNOWN');

CREATE TABLE tool_executions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  effect_ordinal integer NOT NULL DEFAULT 0 CHECK (effect_ordinal >= 0),
  tool_name text NOT NULL,
  tool_version text NOT NULL,
  effect_class text NOT NULL CHECK (effect_class IN (
    'PURE', 'REPEATABLE_READ', 'RECEIVER_IDEMPOTENT_WRITE',
    'TRANSACTIONAL_LOCAL_WRITE', 'RECONCILIABLE_WRITE', 'UNSAFE_WRITE'
  )),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_record_id uuid NOT NULL,
  invocation_status text NOT NULL CHECK (invocation_status IN (
    'PREPARED', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'ABANDONED', 'UNKNOWN'
  )),
  receiver_id text,
  receipt_json jsonb,
  sent_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tool_execution_step_run_fk FOREIGN KEY (step_id, run_id)
    REFERENCES workflow_steps(id, run_id) ON DELETE CASCADE,
  CONSTRAINT tool_execution_attempt_step_fk FOREIGN KEY (attempt_id, step_id)
    REFERENCES step_attempts(id, step_id) ON DELETE CASCADE,
  CONSTRAINT tool_execution_idempotency_step_fk FOREIGN KEY (idempotency_record_id, step_id)
    REFERENCES idempotency_records(id, operation_id) ON DELETE RESTRICT,
  UNIQUE (attempt_id, effect_ordinal)
);

CREATE INDEX tool_executions_step_effect_idx
  ON tool_executions (step_id, effect_ordinal, created_at);

CREATE INDEX tool_executions_unresolved_idx
  ON tool_executions (invocation_status, created_at)
  WHERE invocation_status IN ('IN_FLIGHT', 'UNKNOWN');

-- This table models the controlled receiver's independent durable ledger. It has
-- deliberately no foreign key into AgentFlow's runtime tables.
CREATE TABLE controlled_publication_effects (
  id uuid PRIMARY KEY,
  receiver_namespace text NOT NULL,
  idempotency_key text,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  payload_json jsonb NOT NULL,
  receipt_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX controlled_publication_dedup_idx
  ON controlled_publication_effects (receiver_namespace, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
