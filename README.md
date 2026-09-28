# AgentFlow

AgentFlow is a durable workflow runtime for bounded AI-agent execution. The TypeScript platform includes an Express control API, PostgreSQL-authoritative execution state, a transactional dispatch outbox, BullMQ/Redis transport, durable bounded retries, run controls, deadlines, and a worker that executes deterministic logical operations.

The Python research prototype is a separate workstream and is not embedded in this TypeScript platform.

## Architecture in this milestone

```text
Express API
    ↓ short transaction
PostgreSQL run + operation + checkpoint + outbox
    ↓ asynchronous dispatcher
BullMQ / Redis
    ↓ operation reference
Worker → PostgreSQL eligibility check and fenced claim
    ↓ execute outside transaction
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

## Workspace

- `apps/api`: HTTP control surface and outbox dispatcher
- `apps/worker`: BullMQ worker and deterministic operation execution
- `apps/web`: reserved dashboard boundary
- `packages/config`: startup environment validation
- `packages/db`: PostgreSQL pool, migration runner, and migrations
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
```

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

Run verification:

```powershell
pnpm typecheck
pnpm test
```

The integration suite uses the `agentflow_test` database and a dedicated BullMQ queue. `TEST_DATABASE_URL` may override the database, but its database name must end in `_test` or `-test` because the suite truncates its fixtures.

To run the application services in containers as well:

```powershell
docker compose up --build
```

PostgreSQL uses a named persistent volume so execution state survives ordinary container recreation. Redis also uses AOF, but its contents remain non-authoritative and reconstructible by the platform architecture.

## Deliberately deferred

Provider adapters, LLM operations, broader fault injection, and the React dashboard remain deferred.
