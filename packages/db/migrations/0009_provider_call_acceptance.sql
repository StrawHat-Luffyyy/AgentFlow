ALTER TABLE provider_calls
  ADD COLUMN accepted boolean NOT NULL DEFAULT false;

ALTER TABLE provider_calls
  ADD CONSTRAINT provider_call_acceptance_check CHECK (
    (accepted = false)
    OR (status = 'SUCCEEDED' AND finished_at IS NOT NULL)
  );
