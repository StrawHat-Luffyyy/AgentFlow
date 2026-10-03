# Acceptance work map

The acceptance work extends the existing sequential runtime; it does not replace it.

| Requirement | Existing code | Acceptance addition |
| --- | --- | --- |
| Authentication and ownership | API routes and approval binding | Bearer authentication using provisioned SHA-256 token hashes; server-side roles; immutable workflow owner inherited by runs; owner-scoped routes and listing |
| Real faults | `ExecutionFaultHooks`, leases, scheduler, outbox | Separate API/worker processes, abrupt SIGKILL, one-shot external fault ledger, supervisor restart |
| Baselines | B0/B1/A0/A1 simulation | Volatile B0/B1 using shared operation bodies; actual A1 worker; evaluation-only A0 receiver ablation |
| Reference | DBOS SDK scaffold | DBOS steps executing the same corpus transforms, scripted inference, exact approval payload, and receiver |
| Metrics | Attempts, usage, checkpoints, effects | Physical invocation events, timestamps, measured completion transactions, receiver truth, explicit censored outcomes |
| Trials | Seeded configuration and statistics | Real process matrix, raw events, receiver ledger, runtime records, manifests and summaries |
| Demo | Nine-step research workflow | One run with two crash boundaries and pending approval surviving API/worker termination |
| Final report | Proposed H1–H5 | Results must cite completed campaigns, preserve failures, and disclose unsupported claims |

The prior simulator remains available as `eval:simulate` for model exploration. Its output is not runtime acceptance evidence. `eval:run` now selects real execution.

## Authentication

Configure `AGENTFLOW_AUTH_CREDENTIALS` as a JSON array of `{id, tokenHash, roles, expiresAt?}`.
`tokenHash` is the lowercase SHA-256 digest of a cryptographically random bearer token (at least 32 random bytes recommended). `id` is a stable owner identity. Roles are assigned by the server configuration; HTTP reviewer headers are ignored. `expiresAt`, when present, is an ISO UTC timestamp. Remove a credential and restart the API to revoke it. No anonymous API fallback is provided. Health/readiness endpoints are public.

The web console accepts the raw token and keeps it in memory only. All other clients send `Authorization: Bearer <token>`. Use HTTPS outside loopback. The same owner may have multiple scoped credentials; this small MVP does not implement delegated sharing, passwords, or an identity-provider administration UI.

Existing workflows migrate to `legacy-unassigned`. No credential can use that reserved identity. A trusted database operator must explicitly assign those workflows to the intended owner. Once assigned, ownership cannot be changed by ordinary updates. Runs inherit their workflow's owner through their version, including historical runs. Names and creation-key namespaces are scoped to owners.

Approving requires ownership and the exact persisted reviewer role. Reconciliation additionally requires the `operator` role. The API derives reviewer identity from the verified token, not from request fields.

## Evidence boundaries

The real runner requires separate PostgreSQL databases whose names end in `_eval`. Each campaign has its own BullMQ queue and trial identities. It does not truncate application data. The receiver ledger commits separately from runtime completion and survives killed workers.

B0/B1 restart their cursor and data from scratch. Their external event log is instrumentation and their external approval service represents the human actor; neither is consulted to resume application progress. B1 uses a stable publication key. A0 uses the production durable execution path but substitutes an evaluation-only non-deduplicating receiver invocation at the write boundary. Production A1 behavior is unchanged.

The provider is the deterministic scripted adapter for controlled trials. Token counts are labelled estimates, never billed usage. A successful report-hash/citation check proves artifact integrity, not semantic report quality. A real-provider campaign, five-run performance experiment, dependency-outage campaigns, and checkpoint-granularity experiments require separate evidence; a passing mock-provider process matrix must not be substituted for them.

## Final acceptance and empirical verification summary

- **Authentication and Ownership:** Fully implemented with SHA-256 bearer tokens, role checks (`research-reviewer`, `operator`), and immutable ownership inherited by runs.
- **Real Fault Injection:** Fully verified with separate OS child processes and abrupt `SIGKILL` at explicit boundaries.
- **Primary Matrix Execution:** Executed across B0, B1, and A1 for scenarios E0–E7 (120 trials). A1 had zero committed re-executions and zero duplicates on E5.
- **A0 Ablation:** 15 trials executed on E0, E5, E6, demonstrating the necessity of receiver cooperation.
- **Reference Comparison:** 25 trials executed on DBOS SDK 5.2.11 against `agentflow_reference_eval`.
- **Side-Effect Safety:** 1,000 E5 trials executed for each system (4,000 trials total); A1 produced 0 duplicates (Wilson 95% CI: [0.9962, 1.0000]).
- **Checkpoint Granularity:** 900 trials executed across granularities 1, 2, 4 (8–12% speedup with grouped checkpoints).
- **Accepted Limitations:** The Python prototype was not implemented in code; live provider runs against external network endpoints were deferred; real primary matrix was executed at 5 trials/condition.
