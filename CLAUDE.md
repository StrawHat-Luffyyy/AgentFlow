# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AgentFlow is a durable workflow runtime for AI agents (TypeScript, pnpm monorepo). PostgreSQL is the single source of truth; Redis/BullMQ is only transport. It is also a research artifact: `evaluation-results/` holds evidence cited by the README, so claims in docs must stay consistent with that evidence (real measured campaigns vs. seeded simulator output are always labelled separately — never conflate them).

## Commands

Requires Node 24+, pnpm 11.9, and Docker for PostgreSQL 17 + Redis 7.

```bash
pnpm install
docker compose up -d postgres redis   # fresh volume also creates agentflow_test etc. (infra/docker/init)
pnpm db:migrate                        # applies packages/db/migrations/*.sql in name order
pnpm dev:api                           # Express API :3000 — refuses to start without AGENTFLOW_AUTH_CREDENTIALS
pnpm dev:worker                        # BullMQ worker
pnpm dev:web                           # Vite dashboard :4173, proxies /api -> :3000
pnpm typecheck                         # per-package tsc --noEmit
pnpm build                             # same as typecheck for most packages; web also runs vite build
```

Tests (Vitest, run from repo root; no vitest config file):

```bash
pnpm test                                          # unit + integration
pnpm test:integration                              # needs live Postgres + Redis
pnpm exec vitest run tests/unit/harness.test.ts          # single file
pnpm exec vitest run tests/unit/harness.test.ts -t "provider adapters"   # single test/describe by name
```

Integration tests use `TEST_DATABASE_URL` (default `.../agentflow_test`) and **truncate it** — they refuse any database whose name doesn't end in `_test`/`-test`.

Config is read from `process.env` via zod in `packages/config` (no dotenv loading); `.env.example` lists every variable. `LEASE_HEARTBEAT_MS` must be < `OPERATION_LEASE_MS`. `AGENTFLOW_AUTH_CREDENTIALS` is a JSON array of `{id, tokenHash (sha256 hex), roles}` — see README §13 for a generator one-liner.

Evaluation: `pnpm eval:demo` (one real A1 run with crash recovery), `pnpm eval:run` / `pnpm eval:dbos` (real multi-process campaigns), `pnpm eval:simulate` (seeded simulator). Full campaign invocations are in README §14.

## Architecture

No package is compiled: every workspace package's `exports` points at `src/index.ts` and everything runs through `tsx`. Strict ESM with `NodeNext` resolution, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.

Execution pipeline:

```
API (apps/api) --short txn--> Postgres (runs, operations, attempts, checkpoints, outbox)
  outbox dispatcher (apps/api/src/outbox.ts) --> BullMQ job = operation reference only
  worker (apps/worker) --> re-checks eligibility in Postgres, fenced lease claim
     --> harness (packages/harness) --> provider / tool
     --> single txn: result + attempt + operation status + checkpoint + successor + outbox row
  scheduler (apps/api/src/scheduler.ts) --> repairScheduling(): expired leases, due retries,
     run deadlines, rebuilding lost queue deliveries from Postgres
```

Key invariants to preserve when editing:

- **Queue delivery never authorizes execution.** Workers must claim via `claimOperation` in Postgres; a Redis flush must be recoverable from DB state alone.
- **Fencing epochs**: completions/renewals carry the lease epoch; stale workers' commits are rejected. Any new commit path must check it.
- **All state transitions live in `packages/runtime/src/index.ts`** (one large file: run creation, claim, complete, failure settlement, approvals, run control, reconciliation, harness LLM/tool begin/complete). Apps are thin wrappers around these functions; put new domain logic there, not in route handlers.
- **Error classes** drive retries: `TRANSIENT` (backoff + jitter), `PERMANENT`, `TIMEOUT`, and `UNKNOWN` for ambiguous external writes (`classifyOperationError`).
- **Side-effect contracts**: `RECEIVER_IDEMPOTENT_WRITE` derives a deterministic idempotency key from the workflow envelope; `UNSAFE_WRITE` outcomes after a crash go to `UNKNOWN` with a `RECONCILIATION` wait reason (resolved via `POST /tool-executions/:id/reconcile`, operator role) — never auto-resend.
- **Approvals** park runs in `WAITING` without holding a worker; role-gated (`research-reviewer`). Several tables (approvals, side effects) are made immutable by DB triggers in migrations 0004/0006.
- **Ownership**: workflows have an immutable owner inherited by runs; API endpoints are owner-scoped. Auth is SHA-256 bearer token with constant-time compare (`apps/api/src/auth.ts`).

Packages:

- `shared` — canonical JSON, queue contracts, zod schemas, `defaultWorkflowDefinition`.
- `db` — pg pool + migration runner (tracks applied files in `agentflow_migrations` under an advisory lock; migrations are never edited after being applied — add a new numbered file).
- `harness` — `AgentHarness`, `ProviderRegistry`/`ToolRegistry`, provider adapters (OpenAI Responses, Ollama, `DeterministicFakeProvider`) normalized to a common `LLMResponse`.
- `research` — the nine-step cloud-comparison reference workflow, fixed corpus, and `ScriptedResearchProvider` used by tests and evaluation.
- `evaluation` — real runner (`real-runner.ts` spawns separate API/worker/baseline OS processes, injects `SIGKILL` at named `ExecutionFaultBoundary` hooks, records an independent receiver ledger), DBOS reference runner, and the separate seeded simulator (`cli.ts`). Systems: B0/B1 (volatile baselines), A0 (AgentFlow without receiver cooperation), A1 (full), DBOS. Scenarios E0–E7 are defined in README §8.
- `telemetry` — OpenTelemetry setup (imported via each app's `instrumentation.ts`).

`apps/web` is a React 19 + Vite operations dashboard talking to the API through the `/api` proxy (`src/api.ts`).

## Repo notes

- Top-level `*.md` files other than README (`AgentFlow-Research-and-Architecture.md`, `prototype_concept.md`, etc.) are early design notes; the Python prototype they describe was never implemented. Treat README + code as authoritative.
- Only the campaign directories cited in README §15 are tracked under `evaluation-results/`; other runs are gitignored scratch.
