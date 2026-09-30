ALTER TABLE workflow_steps
  DROP CONSTRAINT workflow_steps_kind_check;

ALTER TABLE workflow_steps
  ADD CONSTRAINT workflow_steps_kind_check
    CHECK (kind IN ('DETERMINISTIC', 'APPROVAL', 'TOOL', 'AGENT')),
  ADD COLUMN agent_config_json jsonb;

ALTER TABLE workflow_steps
  ADD CONSTRAINT workflow_steps_agent_config_check
    CHECK ((kind = 'AGENT') = (agent_config_json IS NOT NULL));
