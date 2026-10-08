-- Advisory readiness data for the operations UI: which providers each live worker has
-- registered. Never read by run creation, claiming, leasing, execution, or scheduling.
CREATE TABLE worker_heartbeats (
  worker_id text PRIMARY KEY,
  providers jsonb NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX worker_heartbeats_last_seen_idx ON worker_heartbeats(last_seen_at);
