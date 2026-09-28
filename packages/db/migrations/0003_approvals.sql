ALTER TABLE workflow_steps
  DROP CONSTRAINT workflow_steps_kind_check,
  DROP CONSTRAINT workflow_steps_status_check;

ALTER TABLE workflow_steps
  ADD CONSTRAINT workflow_steps_kind_check
    CHECK (kind IN ('DETERMINISTIC', 'APPROVAL')),
  ADD CONSTRAINT workflow_steps_status_check
    CHECK (status IN (
      'PENDING', 'READY', 'RUNNING', 'RETRY_WAIT', 'WAITING_APPROVAL',
      'SUCCEEDED', 'FAILED', 'CANCELLED'
    )),
  ADD CONSTRAINT workflow_steps_id_run_unique UNIQUE (id, run_id);

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id uuid NOT NULL,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  proposal_json jsonb NOT NULL,
  proposal_hash text NOT NULL CHECK (length(proposal_hash) = 64),
  payload_json jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (length(payload_hash) = 64),
  reviewer_role text NOT NULL,
  expires_at timestamptz NOT NULL,
  decision text CHECK (decision IN ('APPROVE', 'REJECT')),
  decision_at timestamptz,
  decided_by text,
  decided_role text,
  decision_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approvals_step_run_fk FOREIGN KEY (step_id, run_id)
    REFERENCES workflow_steps(id, run_id) ON DELETE CASCADE,
  UNIQUE (step_id, generation),
  UNIQUE (decision_request_id),
  CHECK (
    (status = 'PENDING' AND decision IS NULL AND decision_at IS NULL
      AND decided_by IS NULL AND decided_role IS NULL AND decision_request_id IS NULL)
    OR
    (status = 'APPROVED' AND decision = 'APPROVE' AND decision_at IS NOT NULL
      AND decided_by IS NOT NULL AND decided_role IS NOT NULL AND decision_request_id IS NOT NULL)
    OR
    (status = 'REJECTED' AND decision = 'REJECT' AND decision_at IS NOT NULL
      AND decided_by IS NOT NULL AND decided_role IS NOT NULL AND decision_request_id IS NOT NULL)
    OR
    (status IN ('EXPIRED', 'CANCELLED') AND decision IS NULL AND decision_at IS NOT NULL
      AND decided_by IS NULL AND decided_role IS NULL AND decision_request_id IS NULL)
  )
);

CREATE INDEX approvals_pending_expiry_idx
  ON approvals (expires_at, id) WHERE status = 'PENDING';

CREATE INDEX approvals_reviewer_status_idx
  ON approvals (reviewer_role, status, created_at);
