# AgentFlow — Durable Workflow Runtime for AI Agents

AgentFlow is a model- and framework-agnostic runtime that executes, persists, monitors, and controls AI-agent workflows. It provides an execution layer between an AI agent and external systems (tools, APIs, human reviewers), ensuring that long-running agent workflows survive process crashes, preserve committed progress, enforce human-in-the-loop approvals, and avoid duplicate side effects upon restart.

The runtime is implemented in TypeScript with an Express control API, PostgreSQL-authoritative state, BullMQ/Redis transport, worker lease fencing, outbox dispatching, and a React operations dashboard.

---

## 1. Overview

### What AgentFlow Is
AgentFlow sits between an AI agent and the external world. While the agent reasons and decides what actions to take, AgentFlow is responsible for making workflow execution reliable, observable, recoverable, and controllable.

```text
                    ┌─────────────────────────┐
                    │       AI AGENT          │
                    │   reasoning & planning  │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │       AGENTFLOW         │
                    │   EXECUTE • REMEMBER    │
                    │        • CONTROL        │
                    └────────────┬────────────┘
                                 │
                         ┌───────┴───────┐
                         ▼               ▼
                      TOOLS            APIS
```

### The Problem It Solves
Ordinary agent loops execute in volatile process memory. When a worker process crashes, times out, or reboots:
- **Lost Progress:** The entire execution context is lost, forcing the agent to restart from scratch.
- **Repeated Inference Costs:** Expensive, multi-turn LLM calls that already succeeded must be re-run, multiplying latency and token charges.
- **Duplicate Side Effects:** An unacknowledged external write (e.g. sending a payment or publishing a report) leaves the system uncertain whether the action occurred. Volatile restarts blindly resend, causing double-execution.
- **Ephemeral Approvals:** Pausing for human review leaves workers blocked in memory, and an API/worker restart loses the approval gate.

### Architecture in One Pipeline
AgentFlow decouples workflow control, queue transport, and worker execution through transactional PostgreSQL boundaries:

```text
Client / SDK / Dashboard
    ↓ HTTP (Bearer Auth & Session Cookies)
Express API
    ↓ short database transaction
PostgreSQL (runs, operations, checkpoints, outbox)
    ↓ asynchronous dispatcher
BullMQ / Redis
    ↓ operation reference
Worker → PostgreSQL eligibility check and fenced lease claim
    ↓ harness → normalized provider / tool boundary
Atomic result + attempt + operation + checkpoint + successor + outbox
```

---

## 2. Key Capabilities

- **Durable PostgreSQL State:** PostgreSQL is the authoritative state store. Workflow definitions, runs, steps, attempts, checkpoints, approvals, and execution history are persisted in ACID relational tables. Queue delivery alone never authorizes execution.
- **Atomic Operation Checkpoints:** Every operation commit atomically updates step status, stores input/output snapshots, records execution attempts, and queues successor dispatches in an outbox transaction.
- **Worker Leases & Fencing Epochs:** Workers claim execution through time-bounded database leases (`claim_expires_at`) renewed via heartbeats. Fencing epochs ensure that completions from stale or partition-delayed workers are rejected.
- **Recovery Scheduler:** A background API scheduler continuously scans for expired worker leases, due retries, and timed-out runs, reclaiming abandoned steps and rebuilding missing queue deliveries.
- **Retries, Backoff & Deadlines:** Structured error classification distinguishes `TRANSIENT`, `PERMANENT`, and `TIMEOUT` failures; ambiguous external writes are handled separately as `UNKNOWN`. Transient errors follow exponential backoff with jitter; whole-run deadlines enforce hard bounds.
- **Durable Approvals:** First-class human-in-the-loop gates persist suspended workflow runs in `WAITING` state without consuming worker processes. Pending approvals survive full API and worker restarts and enforce role-gated reviewer permissions (`research-reviewer`).
- **Idempotent Side Effects:** Dedicated `RECEIVER_IDEMPOTENT_WRITE` contracts derive deterministic idempotency keys from the workflow envelope, enabling cooperating external receivers to deduplicate retried side effects upon crash recovery.
- **UNKNOWN & Reconciliation:** For unsupported receivers (`UNSAFE_WRITE`), ambiguous post-crash outcomes are safely transitioned to `UNKNOWN` with a `RECONCILIATION` wait reason, preventing dangerous automated duplicate dispatches.
- **Provider Abstraction:** The harness layer decouples workflow logic from provider-specific wire schemas. AgentFlow standardizes on Google Gemini (`gemini-3.5-flash` via `@google/genai`) as its production LLM provider with tool calling and structured schemas, while preserving a deterministic scripted provider for reproducible benchmark evaluation.
- **Observability:** Native OpenTelemetry instrumentation exports standardized spans; execution history logs provide an immutable audit trail (`GET /runs/:id/history`).
- **Dual Authentication & Ownership:** Session-cookie authentication (`HttpOnly`, `SameSite=Lax`) with `scrypt` password hashing for the operations dashboard; constant-time SHA-256 bearer tokens for CLI, runners, and automated integrations; immutable workflow ownership inherited by runs.

---

## 3. Architecture

```text
┌─────────────────┐       ┌────────────────────────────────────────────────────────┐
│   Client / UI   │ ────> │                      Express API                       │
└─────────────────┘       │   routes • auth • ownership • scheduler • outbox       │
                          └──────────────────────────┬─────────────────────────────┘
                                                     │
                                                     ▼
                          ┌────────────────────────────────────────────────────────┐
                          │                  PostgreSQL Database                   │
                          │   runs • steps • attempts • checkpoints • approvals   │
                          │   outbox_messages • controlled_publication_effects     │
                          └──────────────────────────┬─────────────────────────────┘
                                                     │ Outbox Poller
                                                     ▼
                          ┌────────────────────────────────────────────────────────┐
                          │                     BullMQ / Redis                     │
                          │   ephemeral queue transport & operation references     │
                          └──────────────────────────┬─────────────────────────────┘
                                                     │ Job Dispatch
                                                     ▼
                          ┌────────────────────────────────────────────────────────┐
                          │                     Worker Process                     │
                          │   fenced lease claim • execute • atomic commit         │
                          │                     ┌───────────┐                      │
                          │                     │  Harness  │                      │
                          │                     └─────┬─────┘                      │
                          └───────────────────────────┼────────────────────────────┘
                                                      │
                                   ┌──────────────────┴──────────────────┐
                                   ▼                                     ▼
                        ┌─────────────────────┐               ┌─────────────────────┐
                        │    LLM Providers    │               │    External Tools   │
                        │    Google Gemini    │               │   Receiver Ledger   │
                        └─────────────────────┘               └─────────────────────┘
```

1. **Express API:** Validates incoming requests, authenticates callers via session cookies (web dashboard) or bearer tokens (CLI/SDK), manages immutable workflow ownership, and writes run creation keys atomically.
2. **Outbox Dispatcher:** Reads pending dispatches from PostgreSQL and pushes operation job references to BullMQ. If Redis is restarted or flushed, deliveries are rebuilt from PostgreSQL.
3. **Worker:** Receives a job reference, verifies eligibility against PostgreSQL, claims a time-bounded lease, and invokes the operation through the harness.
4. **Harness & Tool Boundary:** Maps model inputs/outputs, invokes Google Gemini (`gemini-3.5-flash`) or the scripted provider, enforces tool allowlists, checks capability contracts, and executes deterministic or side-effecting operations.
5. **Atomic Result Commit:** Worker commits operation outputs, creates successor steps, advances run status, and commits the checkpoint in a single PostgreSQL transaction.

---

## 4. Tech Stack

- **Runtime & Language:** Node.js v24+, TypeScript 5.9 (strict ESM)
- **API Framework:** Express 5.1
- **LLM Integration:** Google Gemini SDK (`@google/genai` 2.27+) targeting `gemini-3.5-flash`
- **Database & Storage:** PostgreSQL 17 (Docker Compose image; via `pg` pool, schema migrations in `packages/db`)
- **Queue & Transport:** Redis 7, BullMQ 5
- **Authentication:** Dual-mode authentication:
  - Session-cookie web auth (`POST /auth/login`, `POST /auth/logout`, `GET /me`, HTTP-only `agentflow_session`, `scrypt` password hashing)
  - Bearer token auth (`Authorization: Bearer <token>`, constant-time SHA-256 verification)
- **Reference Durable System:** DBOS TypeScript SDK 5.2.11 (`@dbos-inc/dbos-sdk`)
- **Operations Console:** React 19, Vite 7, Lucide Icons
- **Validation & Schemas:** Zod 3.23
- **Telemetry:** OpenTelemetry SDK (`@opentelemetry/sdk-node`, `@opentelemetry/api`)
- **Testing & Verification:** Vitest 3.2, Docker Compose

---

## 5. Project Structure

```text
AgentFlow/
├── apps/
│   ├── api/                 # Express 5 control API, dual auth, scheduler, outbox
│   ├── cli/                 # `agentflow` terminal CLI (thin HTTP client of the API)
│   ├── worker/              # BullMQ worker process, fenced claim, execution
│   └── web/                 # React 19 / Vite operations dashboard (session auth)
├── packages/
│   ├── config/              # Environment configuration & validation (native .env loading)
│   ├── db/                  # PostgreSQL pool, migrations (runs, approvals, sessions, users)
│   ├── evaluation/          # Real multi-process runner, fault hooks, DBOS runner, seeded simulator
│   ├── harness/             # LLM provider registry, Google Gemini adapter, tools, live-validate CLI
│   ├── research/            # Fixed evaluation corpus, cloud-comparison workflow, scripted provider
│   ├── runtime/             # Core durable domain transactions, state machine, leases
│   ├── shared/              # Canonical JSON, queue contracts, shared schemas
│   └── telemetry/           # OpenTelemetry span exporters and attribute schemas
├── evaluation-results/      # Evaluation evidence (real campaigns and labelled simulator output)
├── tests/
│   ├── unit/                # Unit tests: Gemini adapter (mocked), auth, research, harness, evaluation
│   └── integration/         # Real PostgreSQL + Redis suite (durable path, session auth, opt-in live Gemini)
└── docker-compose.yml       # Local PostgreSQL 17 and Redis 7 services
```

---

## 6. Reference Workflow

The primary evaluation and demonstration workload is the nine-step **Cloud Comparison Workflow**:

```text
search-aws (DETERMINISTIC)
    ↓
search-azure (DETERMINISTIC)
    ↓
search-gcp (DETERMINISTIC)
    ↓
collect-sources (DETERMINISTIC)
    ↓
analyze-pricing (AGENT - LLM)
    ↓
analyze-features (AGENT - LLM)
    ↓
generate-report (DETERMINISTIC)
    ↓
approve-publication (APPROVAL GATE - Human Reviewer)
    ↓
publish-report (CONTROLLED SIDE EFFECT - Idempotent Receiver)
```

- **Fixed Deterministic Corpus:** Uses six versioned, immutable provider source records (`cloud-comparison-2026-09-30.v1`, hash `79b076dd...`). This prevents changing live web content from confounding reliability benchmarks.
- **Approval Gate:** The generated Markdown report, source citations, and publication target are bound by SHA-256 hashes into an approval proposal. The run suspends in `WAITING` until an authorized reviewer (`research-reviewer` role) approves the exact payload hash.
- **Idempotent Publication:** Calls `publishToControlledReceiver` with `RECEIVER_IDEMPOTENT_WRITE`. The independent receiver commits the receipt into its own ledger (`controlled_publication_effects`).

---

## 7. Reliability & Recovery

### Crash & Restart Invariants
When a worker process crashes abruptly (e.g. `SIGKILL` or hardware power loss):
1. **Committed Steps are Preserved:** Any step with an `after-checkpoint-commit` timestamp remains committed in PostgreSQL. On restart, the worker queries eligible steps and skips all committed work.
2. **Unfinished Steps are Re-claimed:** The recovery scheduler identifies the expired lease, increments the fencing epoch, and re-dispatches the step.
3. **Pending Approvals Survive Restarts:** The workflow remains in `WAITING` state across full API and worker restarts; when services resume, the approval gate can be completed without data loss.

### Side-Effect Safety Contract
AgentFlow does **not** claim universal exactly-once execution across arbitrary uncoordinated systems (an impossibility over fallible networks). Instead, side-effect safety is achieved through an explicit contract:
- **Cooperating Receivers (`RECEIVER_IDEMPOTENT_WRITE`):** The runtime supplies a deterministic idempotency key derived from the trial/workflow envelope. If a worker crashes after the receiver commits but before the local checkpoint commits, the retried request presents the same key, allowing the receiver to return the existing receipt without duplicate side effects.
- **Non-Cooperating Receivers (`UNSAFE_WRITE`):** If a crash occurs after an uncoordinated write, the outcome is fundamentally ambiguous. AgentFlow halts the run in `UNKNOWN` state and flags it for `RECONCILIATION`, refusing to blindly resend.

---

## 8. Evaluation

The evidence comes from two different kinds of campaign, and they must not be conflated:

- **Real campaigns (measured):** separate API, worker, and baseline OS processes (`packages/evaluation/src/real-runner.ts`) against live PostgreSQL and Redis, with abrupt `SIGKILL` at named execution boundaries and an independent receiver ledger. Latencies, recovery times, LLM-call counts, and duplicate effects are measured from persisted events.
- **Seeded simulator (modelled):** an in-process deterministic model of the same nine-operation workload (`packages/evaluation/src/cli.ts`, `pnpm eval:simulate`). Its latencies are fixed per-operation constants plus a sampled 2–4 ms checkpoint cost, and its receiver/checkpoint behaviour is encoded in the model. It explores design trade-offs; it is **not** runtime acceptance evidence.

### Evaluated Systems
- **B0 (Volatile Baseline):** Standard in-memory agent loop with bounded retries. On crash, process restarts from step 1, repeating all prior work; non-idempotent writes.
- **B1 (Volatile Baseline + Stable Keys):** Restarts from step 1 on crash, but uses a stable receiver key to isolate receiver deduplication from checkpoint recovery.
- **A0 (AgentFlow Ablation):** Full AgentFlow checkpoint durability, but with receiver cooperation disabled (`UNSAFE_WRITE`) by an evaluation-only adapter.
- **A1 (Full AgentFlow):** The production sequential durable runtime with PostgreSQL checkpoints and receiver idempotency contracts.
- **DBOS (Reference):** Matched common subset executed using the DBOS TypeScript SDK v5.2.11 against a dedicated PostgreSQL database (`agentflow_reference_eval`).

### Injected Fault Scenarios (E0–E7, real runner)
- **E0:** No fault (baseline overhead, checkpoint latency).
- **E1:** Crash before executing step 6 (`analyze-features`), after five committed steps.
- **E2:** Crash after the `analyze-features` provider response, before its local checkpoint commit.
- **E3:** Injected transient provider 503 on `analyze-pricing` (two failures, then success).
- **E4:** Read timeout (50 ms) on `search-azure`.
- **E5:** Remote success / local crash (worker killed after receiver commit, before step checkpoint).
- **E6:** Same crash as E5, but the publication is declared `UNSAFE_WRITE` (no receiver idempotency).
- **E7:** API and worker processes killed and restarted while an approval is pending.

The simulator uses the same scenario names, but its fault positions are not identical (for example, simulator E1 crashes after the `collect-sources` checkpoint).

---

## 9. Results

### Real campaigns (measured)

| Campaign | Systems | Scenarios | Trials | Finding |
|---|---|---|---|---|
| **Primary Real Matrix** | B0, B1, A1 | E0–E7 | **120** (5/condition) | A1: **0 committed re-executions** and **0 duplicate effects** in all 40 trials; all E0–E5 and E7 trials `SUCCEEDED`, all E6 trials ended `UNKNOWN`. A1 repeated **0** LLM calls on E1, E5, E6, E7 versus 5–10 per condition for B0/B1. On E2 A1 repeated the one uncommitted call per trial (5 total), as designed. |
| **Targeted A0 Ablation** | A0 | E0, E5, E6 | **15** (5/condition) | A0 preserved checkpoints but produced a duplicate effect in **5/5** E5 and **5/5** E6 trials: checkpoint durability alone does not prevent duplicate effects after a remote-success/local-crash. |
| **DBOS Reference** | DBOS | E0, E1, E2, E5, E7 | **25** (5/condition) | DBOS also showed 0 committed re-executions and 0 duplicates on the common subset; p95 crash-to-resume 2.39–2.47 s (includes process relaunch; not a like-for-like latency comparison). |
| **Acceptance DEMO** | A1 | DEMO | **1** | See [Demo](#10-demo). |

- **Checkpoint commit latency (A1):** p95 per condition **24–32 ms** on local PostgreSQL (A0: 26–34 ms). Instrumentation overhead is included.
- **Crash recovery (A1, 1,000 ms lease):** p95 crash-to-resumed-operation **1.19–1.23 s**.
- **E6 (unsupported receiver):** A1 halted in `UNKNOWN`/`RECONCILIATION` with **0 duplicate effects** in 5/5 trials; B0, B1, and A0 each duplicated in 5/5 trials.
- **Sample size:** with 5 trials per condition, a 0/5 failure count bounds the per-trial failure rate only loosely (Wilson 95% upper bound ≈ 43%). These results show the invariants held in every observed trial; they are not statistical guarantees, and latency percentiles are descriptive.

### Seeded simulator (modelled, not measured)

| Campaign | Systems | Scenarios | Simulated trials | Model output |
|---|---|---|---|---|
| **E5 model sweep** | B0, B1, A0, A1 | E5 | 4,000 (1,000/system) | A1 and B1: 0 duplicates; A0 and B0: duplicates in 1,000/1,000. The model is deterministic for this condition, so the trial count adds no statistical evidence about the real runtime. |
| **Checkpoint granularity model** | A1 | E0, E1, E5 | 900 (g = 1, 2, 4) | Grouping checkpoints over non-side-effecting operations reduced *modelled* median elapsed time by 7–8% (g=2) and 10–12% (g=4), with 0 modelled duplicates. Production AgentFlow always checkpoints per operation; grouping is not implemented in the runtime. |

> [!NOTE]
> Token counts are labelled estimates from the scripted research provider (`usageProvenance: "estimated-scripted-provider"`, word count × 1.35), not billed provider usage.

---

## 10. Demo

`pnpm eval:demo` runs the nine-step cloud-comparison workflow as one A1 run against real PostgreSQL and Redis, with the API, worker, and supervisor as separate OS processes:

1. **Workflow initiation:** the run starts over the fixed six-document corpus.
2. **Progress checkpointing:** the first five operations (`search-aws` through `analyze-pricing`) commit checkpoints.
3. **Fault 1 (worker crash):** the worker is killed with `SIGKILL` at `before-operation` on `analyze-features`.
4. **Recovery 1:** the supervisor starts a replacement worker; after the 15 s lease expires the step is re-dispatched at a new fencing epoch, and the five committed steps are not re-executed.
5. **Approval gate:** the report is generated and the run waits (`WAITING_APPROVAL`).
6. **Fault 2 (API and worker restart):** both processes are killed while the approval is pending.
7. **Recovery 2:** after restart the pending approval is reloaded from PostgreSQL with an unchanged payload hash.
8. **Role-gated approval:** a reviewer holding `research-reviewer` approves (in the dashboard, or by the supervisor after a 120 s timeout); resubmitting the same decision is verified to be an idempotent replay.
9. **Fault 3 (crash after receiver commit):** the receiver commits the publication to `controlled_publication_effects`, then the worker is killed before its local checkpoint commit.
10. **Recovery 3:** after lease expiry, attempt 2 presents the same idempotency key; the receiver returns the existing receipt and the final checkpoint commits.
11. **Ledger truth:** the independent receiver ledger holds exactly one publication effect (`duplicateEffects = 0`) and the run ends `SUCCEEDED`.

Use `--non-interactive` to skip the dashboard wait and `--no-keep-alive` to exit when the run finishes. Evidence:

- [`evaluation-results/real-1791004304094-c27bb567/`](evaluation-results/real-1791004304094-c27bb567/) — original acceptance run (revision `a2fdfed`, supervisor approval).
- [`evaluation-results/real-demo-audit-20261004/`](evaluation-results/real-demo-audit-20261004/) — re-run during the final audit (revision `06cbe43` plus the audit diff, approval submitted through the dashboard): `SUCCEEDED`, 0 committed re-executions, 0 repeated LLM calls, 1 receiver effect, crash-to-resume 14.7–15.2 s with the 15 s lease.

---

## 11. Limitations

- **Python Prototype Unimplemented:** An early conceptual Execute → Remember → Control research prototype was described in design documents, but was **not implemented in code** (zero `.py` files exist). The functional implementation is entirely in TypeScript.
- **Live Provider End-to-End Campaigns Deferred:** The production Google Gemini provider adapter (`GeminiProvider` using `@google/genai` and `gemini-3.5-flash`) is implemented and validated by unit tests mocking wire protocol, tool execution, and token usage, plus an opt-in live integration test (`pnpm test:gemini-live`) and CLI validator (`pnpm validate:gemini`). However, multi-trial reliability evaluation campaigns were executed using the deterministic `ScriptedResearchProvider` to eliminate non-deterministic external network flakiness, rate limits, and token costs from the benchmark findings.
- **Primary Matrix Sample Count:** The real process matrix was executed at 5 trials per condition (120 real OS process executions). The invariants held in every observed trial, but five trials cannot bound rare failure rates, and latency percentiles are descriptive.
- **Large-Sample Results Are Simulated:** The 4,000-trial E5 sweep and the 900-trial granularity study come from the deterministic seeded simulator, not the runtime. No large-sample real campaign was run, and checkpoint grouping is not implemented in the runtime.
- **DBOS Sample Count:** The DBOS reference system was evaluated over 25 trials on the common subset.
- **Single-Machine Testbed:** All experiments were conducted on a single host running containerized PostgreSQL and Redis. Distributed cluster partitions and multi-region failovers were outside the MVP scope.
- **Token Count Estimates:** Token figures from the scripted provider are estimates based on word count, not billed provider tokens.
- **Report Quality Not Evaluated:** The report-hash and citation checks prove artifact integrity, not semantic report quality.
- **No Reconciliation UI:** `UNKNOWN` effects are resolved through `POST /tool-executions/:id/reconcile` (operator role); the dashboard shows the state but has no reconcile action.

---

## 12. Research Positioning

AgentFlow is an engineering investigation into **restricted, inspectable durable execution for AI agents**. It does **not** claim to invent durable execution (established by systems like Temporal, DBOS, and Cadence) nor does it claim universal exactly-once execution over arbitrary networks.

The project's research contribution lies in:
1. Identifying and measuring the practical cost and overhead of durable checkpointing for multi-step agent tool workflows.
2. Demonstrating the necessity of explicit receiver idempotency contracts to prevent duplicate side effects after remote-success/local-crash failures.
3. Formally handling ambiguous external write outcomes via an `UNKNOWN` / `RECONCILIATION` state machine rather than unsafe automatic resends.
4. Preserving human-in-the-loop approval decisions across abrupt infrastructure failures.

---

## 13. Getting Started

### Prerequisites
- Node.js v24.0.0 or higher
- pnpm v11.9.0 or higher
- Docker & Docker Compose

### 1. Environment Setup
```powershell
pnpm install

# Start PostgreSQL 17 and Redis 7. A fresh volume also creates agentflow_test,
# agentflow_acceptance_eval, and agentflow_reference_eval (infra/docker/init).
docker compose up -d postgres redis
```

On an existing PostgreSQL volume, create any missing databases once:

```powershell
docker compose exec postgres psql -U agentflow -d agentflow -c "CREATE DATABASE agentflow_test" -c "CREATE DATABASE agentflow_acceptance_eval" -c "CREATE DATABASE agentflow_reference_eval"
```

Copy the example environment configuration to `.env` (Node.js 24+ automatically loads `.env` if present):

```powershell
copy .env.example .env
```

### 2. Configure Authentication & Optional Gemini Key

The API supports dual authentication: **Session Cookies** for the React web operations console and **Bearer Tokens** for CLI, runners, and automated API clients.

#### A. Web Operations Console (Username & Password)
Set an administrator password in `.env` (or environment variable). When the API starts, it automatically provisions the `acceptance-owner` user (username defaults to `admin`) with `research-reviewer` and `operator` roles:

```env
AGENTFLOW_ADMIN_PASSWORD="ChooseYourSecurePassword"
AGENTFLOW_ADMIN_USERNAME="admin"
```

#### B. Bearer Tokens (CLI, Tests & SDK)
For programmatic access, generate a token and provision its SHA-256 hash in `AGENTFLOW_AUTH_CREDENTIALS`:

```powershell
node -e "const c=require('crypto');const t=c.randomBytes(32).toString('hex');console.log('token:',t);console.log(JSON.stringify([{id:'local-owner',tokenHash:c.createHash('sha256').update(t).digest('hex'),roles:['research-reviewer','operator']}]))"
$env:AGENTFLOW_AUTH_CREDENTIALS = '<JSON array printed above>'
```

#### C. Optional: Google Gemini Live API
To enable live LLM inference with Google Gemini (`gemini-3.5-flash`), add your Gemini API key to `.env`:

```env
GEMINI_API_KEY="your-gemini-api-key"
GEMINI_MODEL="gemini-3.5-flash"
```

Verify your Gemini configuration at any time:

```powershell
pnpm validate:gemini
```

### 3. Database Migrations
```powershell
pnpm db:migrate
```

### 4. Start Development Services
```powershell
# Terminal 1: Express API on port 3000
pnpm dev:api

# Terminal 2: BullMQ worker
pnpm dev:worker

# Terminal 3: Operations console (React 19 / Vite)
pnpm dev:web
```
The operations dashboard is served at `http://localhost:4173` and proxies `/api` to `http://127.0.0.1:3000`. Sign in with:
- **Username:** `admin` (or `acceptance-owner`)
- **Password:** The password configured in `AGENTFLOW_ADMIN_PASSWORD`

### 5. Run Test Suites
PostgreSQL and Redis must be running; the integration suite truncates `agentflow_test` only, so test files run serially (`--no-file-parallelism`).

```powershell
# Complete test suite: 218 passing (174 unit + 44 integration; 3 live-Gemini skipped if no key)
pnpm test

# Fast in-memory unit tests only (174 tests, no Postgres/Redis required)
pnpm exec vitest run tests/unit

# Real PostgreSQL + Redis integration tests only (44 tests)
pnpm test:integration

# Live Google Gemini integration test (runs when GEMINI_API_KEY is configured)
pnpm test:gemini-live

# Workspace typecheck and build
pnpm typecheck
pnpm build
```

### 6. Use the CLI

`agentflow` is a terminal client for a running AgentFlow API: everything the dashboard does, plus `--json` output, meaningful exit codes, and live `watch`. It talks to the API over HTTP only, so ownership and role checks stay server-side.

```powershell
pnpm agentflow --help                          # run from the repo
pnpm --filter @agentflow/cli link --global     # optional: put `agentflow` on your PATH
```

**Log in.** Use a bearer token (from step 2B) or the web username/password; credentials are stored per profile in `%APPDATA%\agentflow\config.json` (`~/.config/agentflow/config.json` elsewhere, mode 0600):

```powershell
"<token>" | pnpm agentflow login --token --url http://localhost:3000
pnpm agentflow login --username admin          # prompts for the password
pnpm agentflow whoami
pnpm agentflow config use prod                 # switch profiles; --profile <name> per command
```

For CI, skip the config file entirely: `AGENTFLOW_URL`, `AGENTFLOW_TOKEN`, `AGENTFLOW_PROFILE`, and `AGENTFLOW_CONFIG` override stored settings (flags beat env, env beats the profile).

**Run the reference workflow end to end:**

```powershell
pnpm agentflow status                                    # api / database / queue health
$version = pnpm --silent agentflow workflows reference -q
pnpm agentflow runs start $version --input input.json --watch   # exits 12 at the approval gate
pnpm agentflow approvals list
pnpm agentflow approvals approve <approval-id>           # shows the proposal and its hashes, then asks
pnpm agentflow runs watch <run-id>                       # run IDs accept unique 8+ char prefixes
pnpm agentflow runs show <run-id>
pnpm agentflow runs history <run-id>                     # also: attempts, usage, sources, tools, ops
```

`approvals approve` recomputes `sha256(canonicalJson(...))` of the proposal and payload it displays and refuses to sign if they don't match the server's hashes. UNKNOWN side effects are resolved with `agentflow tools reconcile <id> --succeeded --receiver <id> --receipt <file>` or `--fail` (operator role). Irreversible commands (`runs cancel`, `approvals approve|reject`, `tools reconcile`) prompt unless `--yes`, and refuse without `--yes` when stdin is not a terminal.

**Scripting.** stdout carries only data: `--json` prints the API response body, `-q` prints only IDs, and messages go to stderr.

```powershell
pnpm --silent agentflow runs list --json | jq -r '.runs[] | select(.publicStatus=="WAITING_APPROVAL") | .id'
```

| Exit code | Meaning |
|---|---|
| 0 | Success (`watch`: run `SUCCEEDED`) |
| 1 | Generic, network, or unexpected-response error |
| 2 | Usage or validation error (bad flags, HTTP 400) |
| 3 | Not authenticated / forbidden (HTTP 401, 403) |
| 4 | Not found (HTTP 404, unknown run-ID prefix) |
| 5 | Conflict (HTTP 409) |
| 10 / 11 / 14 | `watch`: run `FAILED` / `CANCELLED` / `TIMED_OUT` |
| 12 | `watch`: run reached `WAITING_APPROVAL` or `NEEDS_ATTENTION` (pass `--until-terminal` to keep watching) |
| 13 | `watch`: `--timeout` elapsed |
| 130 | Interrupted (Ctrl-C); the run itself is unaffected |

---

## 14. Evaluation Commands

Real campaigns need PostgreSQL databases ending in `_eval` (see Getting Started). The DEMO binds the API to port 3000.

```powershell
# 1. Real acceptance DEMO (nine-step cloud comparison with crash recovery)
pnpm eval:demo

# 2. Run the primary real evaluation matrix (B0, B1, A1 across E0–E7)
node --import tsx packages/evaluation/src/real-runner.ts --systems B0,B1,A1 --scenarios E0,E1,E2,E3,E4,E5,E6,E7 --trials 5 --lease-ms 1000 --output evaluation-results/real-primary-matrix

# 3. Run the targeted A0 ablation (E0, E5, E6)
node --import tsx packages/evaluation/src/real-runner.ts --systems A0 --scenarios E0,E5,E6 --trials 5 --lease-ms 1000 --output evaluation-results/real-a0-ablation

# 4. Run the matched DBOS reference campaign
pnpm eval:dbos

# 5. SIMULATOR: E5 model sweep (4,000 simulated trials)
node --import tsx packages/evaluation/src/cli.ts --systems B0,B1,A0,A1 --scenarios E5 --trials 1000 --output evaluation-results/e5-safety-1000

# 6. SIMULATOR: checkpoint granularity model (900 simulated trials)
node --import tsx packages/evaluation/src/cli.ts --systems A1 --scenarios E0,E1,E5 --granularity 1,2,4 --trials 100 --output evaluation-results/granularity-ablation

# 7. Live Google Gemini provider validation (requires GEMINI_API_KEY)
pnpm validate:gemini
```

---

## 15. Evidence

The cited campaign directories under [`evaluation-results/`](evaluation-results/) are tracked in git; other local scratch runs are ignored.

Real (measured):
- **[`real-1791004304094-c27bb567/`](evaluation-results/real-1791004304094-c27bb567/):** original acceptance DEMO.
- **[`real-demo-audit-20261004/`](evaluation-results/real-demo-audit-20261004/):** DEMO re-run during the final audit.
- **[`real-primary-matrix/`](evaluation-results/real-primary-matrix/):** 120 primary trials.
- **[`real-a0-ablation/`](evaluation-results/real-a0-ablation/):** 15 A0 ablation trials.
- **[`real-dbos-reference/`](evaluation-results/real-dbos-reference/):** 25 DBOS reference trials.

Simulated (modelled):
- **[`e5-safety-1000/`](evaluation-results/e5-safety-1000/):** 4,000-trial E5 model sweep.
- **[`granularity-ablation/`](evaluation-results/granularity-ablation/):** 900-trial granularity model.

Real campaign directories contain `manifest.json` (source revision, hash of the uncommitted diff, hardware, corpus hash, seed, policy), `results.jsonl`/`results.csv` (per-trial measurements), `summary.json` (Wilson intervals, paired bootstrap differences), `evidence.jsonl` (raw boundary events, receiver rows, runtime snapshots), and `process.log`. Simulator directories contain `manifest.json`, `results.jsonl`/`results.csv`, `summary.json`, and `metrics.prom`.

---

## 16. Status

- **TypeScript AgentFlow Runtime:** **IMPLEMENTED & EVALUATED (MVP scope)**  
  Durable state machine, outbox dispatch, lease fencing, dual session-cookie and Bearer token auth, role-gated approvals, Google Gemini (`gemini-3.5-flash`) provider adapter, receiver contracts, and the `agentflow` terminal CLI are implemented and covered by 218 passing unit/integration tests (221 total in registry), a clean typecheck, and a clean build.
- **Evaluation Artifacts:** **REAL SMALL-SAMPLE CAMPAIGNS + LABELLED SIMULATIONS**  
  Real process campaigns (160 trials plus two DEMO runs) and seeded simulator sweeps (4,900 modelled trials), reported separately.
- **Python Execute → Remember → Control Prototype:** **UNIMPLEMENTED / CONCEPTUAL**  
  The Python prototype remains a conceptual research design documented in early design notes; zero Python code exists in this repository.
