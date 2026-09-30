CREATE TABLE harness_operations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  kind text NOT NULL CHECK (kind IN ('LLM', 'TOOL')),
  turn integer NOT NULL CHECK (turn > 0),
  max_turns integer NOT NULL CHECK (max_turns > 0 AND turn <= max_turns),
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  output_json jsonb,
  continuation_state_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT harness_operation_step_run_fk FOREIGN KEY (step_id, run_id)
    REFERENCES workflow_steps(id, run_id) ON DELETE CASCADE,
  UNIQUE (step_id, ordinal),
  UNIQUE (id, step_id)
);

CREATE INDEX harness_operations_run_idx
  ON harness_operations (run_id, step_id, ordinal);

CREATE TABLE provider_calls (
  id uuid PRIMARY KEY,
  harness_operation_id uuid NOT NULL,
  step_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  call_no integer NOT NULL CHECK (call_no > 0),
  provider text NOT NULL,
  adapter_version text NOT NULL,
  requested_model text NOT NULL,
  status text NOT NULL CHECK (status IN ('IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  provider_request_id text,
  resolved_model text,
  finish_reason text,
  error_json jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT provider_call_harness_operation_fk FOREIGN KEY (harness_operation_id, step_id)
    REFERENCES harness_operations(id, step_id) ON DELETE CASCADE,
  CONSTRAINT provider_call_attempt_fk FOREIGN KEY (attempt_id, step_id)
    REFERENCES step_attempts(id, step_id) ON DELETE CASCADE,
  UNIQUE (harness_operation_id, call_no),
  UNIQUE (harness_operation_id, attempt_id)
);

CREATE INDEX provider_calls_attempt_idx ON provider_calls (attempt_id, started_at);
CREATE INDEX provider_calls_unresolved_idx ON provider_calls (status, started_at)
  WHERE status IN ('IN_FLIGHT', 'UNKNOWN');

CREATE TABLE usage_records (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id uuid NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL REFERENCES step_attempts(id) ON DELETE CASCADE,
  provider_call_id uuid NOT NULL UNIQUE REFERENCES provider_calls(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('reported', 'estimated', 'unknown')),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cached_input_tokens integer CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  reasoning_tokens integer CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  raw_usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX usage_records_run_idx ON usage_records (run_id, created_at);
CREATE INDEX usage_records_provider_model_idx ON usage_records (provider, model, created_at);

CREATE FUNCTION agentflow_reject_harness_operation_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.step_id IS DISTINCT FROM OLD.step_id
    OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.turn IS DISTINCT FROM OLD.turn
    OR NEW.max_turns IS DISTINCT FROM OLD.max_turns
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'harness operation identity fields are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'harness_operation_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER harness_operation_identity_immutable
BEFORE UPDATE ON harness_operations
FOR EACH ROW
EXECUTE FUNCTION agentflow_reject_harness_operation_identity_update();

CREATE FUNCTION agentflow_reject_provider_call_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.harness_operation_id IS DISTINCT FROM OLD.harness_operation_id
    OR NEW.step_id IS DISTINCT FROM OLD.step_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.call_no IS DISTINCT FROM OLD.call_no
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.adapter_version IS DISTINCT FROM OLD.adapter_version
    OR NEW.requested_model IS DISTINCT FROM OLD.requested_model
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
  THEN
    RAISE EXCEPTION 'provider call identity fields are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'provider_call_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_call_identity_immutable
BEFORE UPDATE ON provider_calls
FOR EACH ROW
EXECUTE FUNCTION agentflow_reject_provider_call_identity_update();
