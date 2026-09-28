CREATE FUNCTION agentflow_reject_approval_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.step_id IS DISTINCT FROM OLD.step_id
    OR NEW.generation IS DISTINCT FROM OLD.generation
    OR NEW.proposal_json IS DISTINCT FROM OLD.proposal_json
    OR NEW.proposal_hash IS DISTINCT FROM OLD.proposal_hash
    OR NEW.payload_json IS DISTINCT FROM OLD.payload_json
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.reviewer_role IS DISTINCT FROM OLD.reviewer_role
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'approval identity fields are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'approvals_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approvals_identity_immutable
BEFORE UPDATE ON approvals
FOR EACH ROW
EXECUTE FUNCTION agentflow_reject_approval_identity_update();
