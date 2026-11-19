-- Run-level token and cost budgets (brief §2.5).
--
-- Budgets are enforced from persisted (billed) usage_records before each LLM call
-- and after each response. A breach moves the run to the terminal lifecycle
-- BUDGET_EXCEEDED. price_table_json is the operator-configured price snapshot taken
-- at run creation for runs with a cost budget, so later price changes never alter
-- a run's accounting.

ALTER TABLE workflow_runs
  ADD COLUMN max_tokens bigint CHECK (max_tokens IS NULL OR max_tokens > 0),
  ADD COLUMN max_cost_usd numeric(14, 6) CHECK (max_cost_usd IS NULL OR max_cost_usd > 0),
  ADD COLUMN price_table_json jsonb,
  ADD CONSTRAINT workflow_runs_cost_budget_prices_check
    CHECK (max_cost_usd IS NULL OR price_table_json IS NOT NULL);

ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_lifecycle_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_lifecycle_check
  CHECK (lifecycle IN ('OPEN', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'BUDGET_EXCEEDED'));
