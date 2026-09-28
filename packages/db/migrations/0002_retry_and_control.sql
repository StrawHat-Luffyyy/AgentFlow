ALTER TABLE workflow_runs
  ADD COLUMN control text NOT NULL DEFAULT 'RUN'
    CHECK (control IN ('RUN', 'PAUSE_REQUESTED', 'PAUSED', 'CANCEL_REQUESTED')),
  ADD COLUMN wait_reason text NOT NULL DEFAULT 'NONE'
    CHECK (wait_reason IN ('NONE', 'RETRY', 'APPROVAL', 'RECONCILIATION')),
  ADD COLUMN deadline_at timestamptz,
  ADD COLUMN failure_json jsonb;

UPDATE workflow_runs
SET deadline_at = CASE
  WHEN lifecycle = 'OPEN' THEN now() + interval '5 minutes'
  ELSE created_at + interval '5 minutes'
END
WHERE deadline_at IS NULL;

ALTER TABLE workflow_runs
  ALTER COLUMN deadline_at SET NOT NULL;

CREATE INDEX workflow_runs_open_deadline_idx
  ON workflow_runs (deadline_at, id) WHERE lifecycle = 'OPEN';

ALTER TABLE workflow_steps
  DROP CONSTRAINT workflow_steps_status_check;

ALTER TABLE workflow_steps
  ADD CONSTRAINT workflow_steps_status_check
    CHECK (status IN ('PENDING', 'READY', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  ADD COLUMN retry_initial_ms integer NOT NULL DEFAULT 1000 CHECK (retry_initial_ms >= 0),
  ADD COLUMN retry_multiplier double precision NOT NULL DEFAULT 2 CHECK (retry_multiplier >= 1),
  ADD COLUMN retry_cap_ms integer NOT NULL DEFAULT 30000 CHECK (retry_cap_ms >= 0),
  ADD COLUMN failure_json jsonb;

CREATE INDEX workflow_steps_retry_due_idx
  ON workflow_steps (next_attempt_at, id) WHERE status = 'RETRY_WAIT';

ALTER TABLE step_attempts
  DROP CONSTRAINT step_attempts_status_check;

ALTER TABLE step_attempts
  ADD CONSTRAINT step_attempts_status_check
    CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'ABANDONED', 'CANCELLED')),
  ADD COLUMN error_class text,
  ADD COLUMN retryable boolean;
