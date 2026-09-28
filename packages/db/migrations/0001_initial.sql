CREATE TABLE workflows (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflow_versions (
  id uuid PRIMARY KEY,
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  definition_json jsonb NOT NULL,
  definition_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version),
  UNIQUE (workflow_id, definition_hash)
);

CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY,
  workflow_version_id uuid NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
  creation_key text UNIQUE,
  input_json jsonb NOT NULL,
  input_hash text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('OPEN', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')),
  current_checkpoint_id uuid,
  state_revision integer NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE workflow_steps (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_key text NOT NULL,
  occurrence integer NOT NULL DEFAULT 0 CHECK (occurrence >= 0),
  position integer NOT NULL CHECK (position >= 0),
  kind text NOT NULL CHECK (kind IN ('DETERMINISTIC')),
  handler text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  input_json jsonb NOT NULL,
  accepted_output_json jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner text,
  lease_epoch integer NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at timestamptz,
  dispatch_generation integer NOT NULL DEFAULT 1 CHECK (dispatch_generation > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (run_id, node_key, occurrence),
  UNIQUE (run_id, position)
);

CREATE UNIQUE INDEX workflow_steps_one_running_per_run
  ON workflow_steps (run_id) WHERE status = 'RUNNING';
CREATE INDEX workflow_steps_ready_idx ON workflow_steps (status, created_at) WHERE status = 'READY';
CREATE INDEX workflow_steps_lease_idx ON workflow_steps (lease_expires_at) WHERE status = 'RUNNING';

CREATE TABLE step_attempts (
  id uuid PRIMARY KEY,
  step_id uuid NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  epoch integer NOT NULL CHECK (epoch > 0),
  worker_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'ABANDONED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  finished_at timestamptz,
  error_json jsonb,
  UNIQUE (step_id, attempt_no),
  UNIQUE (step_id, epoch)
);

CREATE TABLE checkpoints (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 0),
  parent_id uuid REFERENCES checkpoints(id) ON DELETE RESTRICT,
  workflow_version_id uuid NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
  cursor text,
  reason text NOT NULL,
  snapshot_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, revision),
  UNIQUE (id, run_id)
);

ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_current_checkpoint_fk
  FOREIGN KEY (current_checkpoint_id, id)
  REFERENCES checkpoints(id, run_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id uuid NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 0),
  kind text NOT NULL CHECK (kind IN ('DISPATCH_OPERATION')),
  payload_json jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (step_id, generation, kind)
);

CREATE INDEX outbox_unpublished_idx
  ON outbox (available_at, id) WHERE published_at IS NULL;

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  step_id uuid REFERENCES workflow_steps(id) ON DELETE SET NULL,
  attempt_id uuid REFERENCES step_attempts(id) ON DELETE SET NULL,
  type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);

CREATE INDEX audit_events_run_sequence_idx ON audit_events (run_id, sequence);
