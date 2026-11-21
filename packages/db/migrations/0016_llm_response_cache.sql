-- Content-addressed LLM response cache (brief §2.2).
--
-- harness_operations already stores every accepted LLM response with its v2
-- request hash, so it doubles as the cache store. This migration adds:
--   * cache_lookup: the cache decision for an LLM logical operation (HIT, MISS,
--     or OFF when the workflow version disables the cache). Set once.
--   * harness_replays.source: JOURNAL (same logical operation replayed after a
--     crash) vs CACHE_RUN / CACHE_VERSION (an identical request answered from an
--     earlier operation), so cache savings are never conflated with journal replay.
--   * a partial index for hash lookups.

ALTER TABLE harness_operations
  ADD COLUMN cache_lookup text CHECK (cache_lookup IN ('HIT', 'MISS', 'OFF'));

CREATE INDEX harness_operations_llm_cache_idx
  ON harness_operations (request_hash)
  WHERE kind = 'LLM' AND status = 'SUCCEEDED' AND request_hash_version = 2;

ALTER TABLE harness_replays
  ADD COLUMN source text NOT NULL DEFAULT 'JOURNAL'
    CHECK (source IN ('JOURNAL', 'CACHE_RUN', 'CACHE_VERSION')),
  ADD COLUMN source_harness_operation_id uuid REFERENCES harness_operations(id) ON DELETE SET NULL;

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
    OR (OLD.cache_lookup IS NOT NULL AND NEW.cache_lookup IS DISTINCT FROM OLD.cache_lookup)
  THEN
    RAISE EXCEPTION 'harness operation identity fields are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'harness_operation_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
