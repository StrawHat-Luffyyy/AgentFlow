-- Existing workflows remain inaccessible until explicitly assigned by an operator.
ALTER TABLE workflows ADD COLUMN owner_id text NOT NULL DEFAULT 'legacy-unassigned';
ALTER TABLE workflows DROP CONSTRAINT workflows_name_key;
ALTER TABLE workflows ADD CONSTRAINT workflows_owner_name_key UNIQUE (owner_id, name);
CREATE INDEX workflows_owner_idx ON workflows(owner_id, id);

CREATE FUNCTION protect_workflow_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.owner_id <> 'legacy-unassigned' AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'workflow ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_owner_immutable BEFORE UPDATE ON workflows
FOR EACH ROW EXECUTE FUNCTION protect_workflow_owner();
