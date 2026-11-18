-- Provider-reported total token count, copied verbatim (never computed), so the
-- normalized input/output counts can be cross-checked against the provider.
-- Rows written before this migration keep NULL.

ALTER TABLE usage_records
  ADD COLUMN total_tokens integer CHECK (total_tokens IS NULL OR total_tokens >= 0);

ALTER TABLE harness_replays
  ADD COLUMN saved_total_tokens integer
    CHECK (saved_total_tokens IS NULL OR saved_total_tokens >= 0);
