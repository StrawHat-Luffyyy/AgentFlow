-- LLM response journal: request-hash versioning and replay accounting.
--
-- harness_operations + provider_calls already form the durable per-call journal
-- (0007/0009). This migration adds:
--   * request_hash_version: v1 = sha256(canonical request), v2 = sha256(canonical
--     {provider, adapterVersion, model, instructions, messages, tools, params,
--     opaqueState}). Existing rows stay v1 so in-flight runs still replay.
--   * harness_replays: one row per attempt that consumed a journalled response
--     instead of calling the provider. usage_records remains billed-only.

ALTER TABLE harness_operations
  ADD COLUMN request_hash_version smallint NOT NULL DEFAULT 1
    CHECK (request_hash_version IN (1, 2));

CREATE OR REPLACE FUNCTION agentflow_reject_harness_operation_identity_update()
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
    OR NEW.request_hash_version IS DISTINCT FROM OLD.request_hash_version
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'harness operation identity fields are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'harness_operation_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE harness_replays (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  harness_operation_id uuid NOT NULL,
  source_provider_call_id uuid NOT NULL REFERENCES provider_calls(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('reported', 'estimated', 'unknown')),
  saved_input_tokens integer CHECK (saved_input_tokens IS NULL OR saved_input_tokens >= 0),
  saved_output_tokens integer CHECK (saved_output_tokens IS NULL OR saved_output_tokens >= 0),
  saved_cached_input_tokens integer
    CHECK (saved_cached_input_tokens IS NULL OR saved_cached_input_tokens >= 0),
  saved_reasoning_tokens integer
    CHECK (saved_reasoning_tokens IS NULL OR saved_reasoning_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT harness_replay_operation_fk FOREIGN KEY (harness_operation_id, step_id)
    REFERENCES harness_operations(id, step_id) ON DELETE CASCADE,
  CONSTRAINT harness_replay_attempt_fk FOREIGN KEY (attempt_id, step_id)
    REFERENCES step_attempts(id, step_id) ON DELETE CASCADE,
  UNIQUE (harness_operation_id, attempt_id)
);

CREATE INDEX harness_replays_run_idx ON harness_replays (run_id, created_at);

CREATE FUNCTION agentflow_reject_harness_replay_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'harness replay records are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'harness_replay_immutable';
END;
$$;

CREATE TRIGGER harness_replay_immutable
BEFORE UPDATE ON harness_replays
FOR EACH ROW
EXECUTE FUNCTION agentflow_reject_harness_replay_update();
