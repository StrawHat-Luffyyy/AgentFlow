# AgentFlow

AgentFlow is a durable workflow runtime for bounded AI-agent execution. The TypeScript platform includes an Express control API, PostgreSQL-authoritative execution state, a transactional dispatch outbox, BullMQ/Redis transport, durable bounded retries, run controls, deadlines, OpenTelemetry tracing, and a React operations console.

The Python research prototype was an early conceptual research design and is not implemented in code in this repository. All execution runtime, state machines, tool harnesses, database migrations, and evaluation systems are implemented in TypeScript.

## Architecture in this milestone

```text
Express API
    ↓ short transaction
PostgreSQL run + operation + checkpoint + outbox
    ↓ asynchronous dispatcher
BullMQ / Redis
    ↓ operation reference
Worker → PostgreSQL eligibility check and fenced claim
    ↓ harness → normalized provider/tool boundary
Atomic result + attempt + operation + checkpoint + successor + outbox
```

PostgreSQL is authoritative. Queue delivery alone never authorizes execution. Workers renew
database leases while executing; the API-side recovery scheduler abandons expired attempts,
advances the fencing epoch through a replacement claim, and recreates missing or stale dispatches.
Logical failures are classified and settled into either a persisted `RETRY_WAIT` with one sampled
due time or a terminal failure. Approval gates and side-effect outcomes are also PostgreSQL-backed.
Tool attempts use stable logical keys and an independent controlled-receiver ledger: supported
receivers safely deduplicate retries, while ambiguous unsupported writes enter `UNKNOWN` and
`RECONCILIATION` without automatic resend. BullMQ does not own business retries or effect safety.
Bounded agent nodes persist every LLM decision and permitted read-only tool call as a separate
turn/ordinal operation. A committed decision is replayed after a worker crash; an uncommitted
provider call may be repeated and is retained with unknown usage rather than counted as zero.

## Workspace

- `apps/api`: HTTP control surface and outbox dispatcher
- `apps/worker`: BullMQ worker and deterministic operation execution
- `apps/web`: React/Vite operations console for run control and inspection
- `packages/config`: startup environment validation
- `packages/db`: PostgreSQL pool, migration runner, and migrations
- `packages/harness`: provider contract, registries, bounded-turn enforcement, and adapters
- `packages/research`: fixed reference corpus, cloud-comparison workflow, report generation, and scripted provider
- `packages/evaluation`: seeded fault experiments, B0/B1/A0/A1 systems, DBOS reference subset, metrics, and statistics
- `packages/runtime`: durable domain transactions and execution semantics
- `packages/shared`: schemas, queue contracts, and shared types
- `tests/integration`: real PostgreSQL/Redis end-to-end verification

## Local development

Copy `.env.example` values into your shell environment if you need to override defaults. Do not commit an `.env` file.

```powershell
pnpm install
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

The dashboard is available at `http://localhost:4173` and proxies `/api` requests to the local
control API. Set `VITE_API_BASE_URL` when the web application and API use different origins.

Create the workflow through the API:

```powershell
$workflow = Invoke-RestMethod -Method Post -Uri http://localhost:3000/workflows -ContentType application/json -Body '{"name":"demo","description":"First durable path"}'
$version = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/workflows/$($workflow.id)/versions" -ContentType application/json -Body '{"version":1,"definition":{"steps":[{"key":"generate-summary","kind":"DETERMINISTIC","handler":"generate-summary"},{"key":"finalize","kind":"DETERMINISTIC","handler":"finalize"}]}}'
$run = Invoke-RestMethod -Method Post -Uri http://localhost:3000/runs -ContentType application/json -Body (ConvertTo-Json @{ workflowVersionId = $version.id; input = @{ topic = "durable agents"; count = 3 }; creationKey = "demo-1" })
Invoke-RestMethod -Uri "http://localhost:3000/runs/$($run.id)"
Invoke-RestMethod -Uri "http://localhost:3000/runs/$($run.id)/history"
```

Runs accept optional `deadlineMs` and `retryPolicy` fields. Durable controls are exposed as
`POST /runs/:id/pause`, `POST /runs/:id/resume`, and `POST /runs/:id/cancel`. The run response
reports independent `lifecycle`, `control`, `waitReason`, and derived `publicStatus` values.

An `AGENT` workflow step pins its provider, model, instructions, read-only tool allowlist, and
turn bound in the immutable workflow version:

```json
{
  "key": "analyze",
  "kind": "AGENT",
  "handler": "agent",
  "provider": "ollama",
  "model": "qwen3:8b",
  "instructions": "Return a concise evidence-based answer.",
  "allowedTools": [],
  "maxTurns": 4
}
```

The standard worker registers Ollama and registers OpenAI Responses when `OPENAI_API_KEY` is set.
Adapters perform one HTTP request and do not hide SDK retries. Application-specific agent tools
are registered through `ToolRegistry`; only `PURE` and `REPEATABLE_READ` tools are accepted, and
their input/output schemas, allowlist membership, and target policy are checked outside the model.
Inspect durable agent evidence at `GET /runs/:id/harness-operations` and usage at
`GET /runs/:id/usage`.

## Observability and operations UI

The API exposes the operations-console read model through:

- `GET /runs?limit=50&offset=0` for newest-first run summaries and usage totals
- `GET /runs/:id` for the ordered step table and committed input/output snapshots
- `GET /runs/:id/attempts` for physical worker attempts and errors
- `GET /runs/:id/history` for the durable audit history
- `GET /runs/:id/usage` for provider-reported or estimated token records

The console supports run selection, step/output inspection, attempt evidence, pause/resume/cancel,
and approval decisions bound to the persisted proposal and payload hashes. It intentionally has no
workflow editor.

Both the API and worker initialize the OpenTelemetry Node SDK at process startup. Configure
`OTEL_EXPORTER_OTLP_ENDPOINT` with an OTLP/HTTP collector base URL; AgentFlow appends
`/v1/traces` when needed. Exported execution spans use the versioned `agentflow.*` attribute schema
for run, workflow-version, step, attempt, and lease identifiers. Inputs, outputs, prompts, and other
content are not placed in trace attributes.

## Reference cloud-comparison workflow

Milestone 6 includes a nine-step AWS/Azure/GCP research workflow:

```text
search-aws → search-azure → search-gcp → collect-sources
→ analyze-pricing → analyze-features → generate-report
→ approve-publication → publish-report
```

The evaluation corpus is a checked-in, versioned snapshot of six paraphrased official-source
records. Each immutable source record includes its publisher, URL, retrieval timestamp, category,
and a SHA-256 hash over the complete provenance snapshot. The corpus has its own aggregate hash.
It is intended for repeatable workflow evaluation, not current purchasing guidance.

Create or retrieve the scripted demonstration workflow without cloud credentials:

```powershell
$reference = Invoke-RestMethod -Method Post -Uri http://localhost:3000/reference-workflows/cloud-comparison -ContentType application/json -Body '{"mode":"scripted"}'
$run = Invoke-RestMethod -Method Post -Uri http://localhost:3000/runs -ContentType application/json -Body (ConvertTo-Json @{ workflowVersionId = $reference.workflowVersionId; creationKey = "cloud-comparison-demo-1"; input = @{ publicationTarget = "controlled://publications/cloud-comparison-demo" } })
Invoke-RestMethod -Uri "http://localhost:3000/runs/$($run.id)/sources"
Invoke-RestMethod -Uri "http://localhost:3000/runs/$($run.id)/approvals"
```

The scripted provider traverses the same durable agent and usage paths as a real adapter. For a
live run, seed with `{"mode":"live","provider":"openai","model":"<model>"}` or an available
Ollama model. The generated Markdown report, publication target, and corpus hash are combined into
an approval binding. Publication is created only after an authorized approval of that exact payload;
the controlled receiver independently deduplicates retries. Inspect the public corpus manifest at
`GET /reference-corpora/cloud-comparison-v1` and per-run evidence at `GET /runs/:id/sources`.

Run verification:

```powershell
pnpm typecheck
pnpm test
```

## Empirical evaluation results

The evaluation harness was verified against real PostgreSQL and Redis services using OS-level process supervision and boundary-level fault injection:

1. **Acceptance DEMO:** End-to-end cloud-comparison workflow with 2 process crashes, supervisor restart across pending approval, and exactly-once publication (`evaluation-results/real-1791004304094-c27bb567/`).
2. **Primary Real Matrix (B0, B1, A1 across E0–E7):** 120 real OS process executions (5 trials per condition) in `evaluation-results/real-primary-matrix/`. A1 achieved 0 committed re-executions, 0 repeated LLM calls on late crashes, and 0 duplicate effects on E5. On E6 (unsupported receiver idempotency), A1 safely halted in `UNKNOWN` state without duplicate sends.
3. **Targeted A0 Ablation (E0, E5, E6):** 15 real trials in `evaluation-results/real-a0-ablation/` demonstrating that state checkpointing without receiver cooperation produces 100% duplicate side effects upon crash after remote commit.
4. **Matched DBOS Reference (E0, E1, E2, E5, E7):** 25 real trials running `@dbos-inc/dbos-sdk` v5.2.11 on a dedicated database (`agentflow_reference_eval`) in `evaluation-results/real-dbos-reference/`.
5. **Dedicated E5 Safety Benchmark:** 4,000 trials (1,000 trials per system: B0, B1, A0, A1) in `evaluation-results/e5-safety-1000/` confirming A1 achieved 0 duplicates (Wilson 95% CI: [0.9962, 1.0000]), while A0 and B0 duplicated in 1,000/1,000 trials.
6. **Checkpoint Granularity Ablation:** 900 trials across granularities 1, 2, and 4 in `evaluation-results/granularity-ablation/`, demonstrating an 8–12% latency reduction with grouped checkpoints while retaining 100% duplicate-free safety.

### Limitations and measurement reality
- **Token Usage:** Token counts are labeled estimates derived from the deterministic scripted provider using a word-count estimator (1.35x), not billed provider usage.
- **Provider Protocol vs Live Runs:** Strict provider protocol, tool call, and usage normalization are verified for OpenAI and Ollama adapters in unit test suites; live network campaigns against paid external APIs were deferred due to unconfigured API keys and local daemon availability.
- **Sample Distribution:** The real process matrix used 5 trials per condition (120 real OS process executions), which conclusively demonstrates deterministic invariant preservation but is descriptive for latency variance.
- **Python Prototype:** The proposed Python research prototype was not implemented in code; all functional capabilities are implemented in TypeScript.
- **Testbed Environment:** Evaluations were conducted on a single-node host running containerized PostgreSQL and Redis.

## Milestone 8 evaluation

The evaluation runner executes paired, seeded trials for B0 (volatile retries), B1 (volatile plus
stable receiver keys), A0 (durable checkpoints without receiver-aware protection), and A1 (the full
contract). E0-E7 have explicit named fault boundaries; faults fire by operation identity and hit
count, not by random sleeps. Approval and write boundaries remain mandatory in the 1/2/4-operation
checkpoint ablation.

Run the default 100-trial mock matrix, or a focused ablation:

```powershell
pnpm eval:run -- --output evaluation-results/full
pnpm eval:run -- --seed 42 --trials 20 --scenarios 'E0,E1,E5,E6' --granularity '1,2,4' --output evaluation-results/ablation
```

Each output directory contains a hashed `manifest.json`, raw canonical `results.jsonl`, tabular
`results.csv`, Prometheus text metrics, and `summary.json`. The summary reports Wilson 95% intervals,
median/p95 measurements, duplicates, unknown outcomes, and seeded paired-bootstrap differences for
B0/B1/A0 versus A1. Manifests record the fault plans, fixed-corpus digest, package
versions, source revision, retry/restart policy, and machine details.

Real worker processes can arm the same deterministic hooks with `AGENTFLOW_FAULT_PLAN`. The hooks
cover pre-operation, lost provider response, remote-effect/local-commit, and checkpoint transaction
boundaries. A `crash` action sends an abrupt process kill; dependency actions become classified
runtime failures. Arm crash plans only on the worker instance intended to be killed, then restart
without the plan so the one-shot fault is not re-armed.

```powershell
$env:AGENTFLOW_FAULT_PLAN='[{"id":"e5","hook":"after-receiver-commit","action":"crash","operationId":"publish-report","occurrence":1}]'
pnpm dev:worker
```

The pinned reference is DBOS SDK 5.2.11 with one durable DBOS step per operation in the common
sequential JSON subset. It uses its own PostgreSQL system schema. The first command below can stop
the process after a recorded step; rerun without `--crash-after` and the same workflow ID to observe
DBOS recovery and output reuse.

```powershell
$env:DBOS_SYSTEM_DATABASE_URL='postgresql://agentflow:agentflow@localhost:5432/agentflow_dbos_eval'
pnpm eval:dbos -- --workflow-id reference-e1 --crash-after analyze-pricing
pnpm eval:dbos -- --workflow-id reference-e1 --output evaluation-results/dbos-reference.json
```

The integration suite uses the `agentflow_test` database and a dedicated BullMQ queue. `TEST_DATABASE_URL` may override the database, but its database name must end in `_test` or `-test` because the suite truncates its fixtures.

To run the application services in containers as well:

```powershell
docker compose up --build
```

PostgreSQL uses a named persistent volume so execution state survives ordinary container recreation. Redis also uses AOF, but its contents remain non-authoritative and reconstructible by the platform architecture.

## Deliberately deferred

Live search/crawl ingestion, normalized current SKU pricing, additional provider adapters, a visual
workflow editor, and automated service-level E8-E12 orchestration remain deferred. The evaluation
package provides the boundary mechanism needed for those service outage and race campaigns, but
does not claim that the pure seeded model replaces abrupt multi-process integration experiments.
