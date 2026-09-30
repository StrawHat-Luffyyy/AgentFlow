CREATE TABLE research_sources (
  id text PRIMARY KEY,
  corpus_version text NOT NULL,
  vendor text NOT NULL CHECK (vendor IN ('AWS', 'AZURE', 'GCP')),
  category text NOT NULL CHECK (category IN ('PRICING', 'MANAGED_KUBERNETES')),
  title text NOT NULL,
  publisher text NOT NULL,
  source_url text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  excerpt text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (corpus_version, source_url),
  UNIQUE (corpus_version, content_hash)
);

CREATE TABLE run_source_evidence (
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id uuid NOT NULL,
  source_id text NOT NULL REFERENCES research_sources(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_source_evidence_step_fk FOREIGN KEY (step_id, run_id)
    REFERENCES workflow_steps(id, run_id) ON DELETE CASCADE,
  PRIMARY KEY (run_id, source_id),
  UNIQUE (run_id, ordinal)
);

CREATE INDEX run_source_evidence_step_idx ON run_source_evidence (step_id, ordinal);

CREATE FUNCTION agentflow_reject_research_source_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'research source snapshots are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'research_source_immutable';
END;
$$;

CREATE TRIGGER research_source_immutable
BEFORE UPDATE ON research_sources
FOR EACH ROW
EXECUTE FUNCTION agentflow_reject_research_source_update();

CREATE FUNCTION agentflow_reject_run_source_evidence_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'run source evidence is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'run_source_evidence_immutable';
END;
$$;

CREATE TRIGGER run_source_evidence_immutable
BEFORE UPDATE ON run_source_evidence
FOR EACH ROW
EXECUTE FUNCTION agentflow_reject_run_source_evidence_update();
