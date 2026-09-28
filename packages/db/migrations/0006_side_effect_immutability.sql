CREATE FUNCTION agentflow_reject_idempotency_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.effect_ordinal IS DISTINCT FROM OLD.effect_ordinal
    OR NEW.scope IS DISTINCT FROM OLD.scope
    OR NEW.tool_namespace IS DISTINCT FROM OLD.tool_namespace
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.receiver_account IS DISTINCT FROM OLD.receiver_account
    OR NEW.retention_until IS DISTINCT FROM OLD.retention_until
  THEN
    RAISE EXCEPTION 'idempotency identity fields are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'idempotency_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER idempotency_identity_immutable
BEFORE UPDATE ON idempotency_records
FOR EACH ROW
EXECUTE FUNCTION agentflow_reject_idempotency_identity_update();

CREATE FUNCTION agentflow_reject_tool_execution_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.step_id IS DISTINCT FROM OLD.step_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.effect_ordinal IS DISTINCT FROM OLD.effect_ordinal
    OR NEW.tool_name IS DISTINCT FROM OLD.tool_name
    OR NEW.tool_version IS DISTINCT FROM OLD.tool_version
    OR NEW.effect_class IS DISTINCT FROM OLD.effect_class
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.idempotency_record_id IS DISTINCT FROM OLD.idempotency_record_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'tool execution identity fields are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'tool_execution_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tool_execution_identity_immutable
BEFORE UPDATE ON tool_executions
FOR EACH ROW
EXECUTE FUNCTION agentflow_reject_tool_execution_identity_update();

CREATE FUNCTION agentflow_reject_receiver_effect_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'controlled receiver effects are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'controlled_receiver_effect_immutable';
END;
$$;

CREATE TRIGGER controlled_receiver_effect_immutable
BEFORE UPDATE ON controlled_publication_effects
FOR EACH ROW
EXECUTE FUNCTION agentflow_reject_receiver_effect_update();
