# AgentFlow — Durable Workflow Runtime for AI Agents

AgentFlow is a model- and framework-agnostic runtime that executes, persists, monitors, and controls AI-agent workflows. It provides an execution layer between an AI agent and external systems (tools, APIs, human reviewers), ensuring that long-running agent workflows survive process crashes, preserve committed progress, enforce human-in-the-loop approvals, and avoid duplicate side effects upon restart.

The runtime is implemented as a production-grade TypeScript platform with an Express control API, PostgreSQL-authoritative state, BullMQ/Redis transport, worker lease fencing, outbox dispatching, and a React operations dashboard.

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
Client / SDK
    ↓ HTTP (Bearer Auth)
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
- **Retries, Backoff & Deadlines:** Structured error classification distinguishes `TRANSIENT`, `PERMANENT`, `TIMEOUT`, and `DEPENDENCY` failures. Transient errors follow exponential backoff with jitter; whole-run deadlines enforce hard bounds.
- **Durable Approvals:** First-class human-in-the-loop gates persist suspended workflow runs in `WAITING` state without consuming worker processes. Pending approvals survive full API and worker restarts and enforce role-gated reviewer permissions (`research-reviewer`).
- **Idempotent Side Effects:** Dedicated `RECEIVER_IDEMPOTENT_WRITE` contracts derive deterministic idempotency keys from the workflow envelope, enabling cooperating external receivers to deduplicate retried side effects upon crash recovery.
- **UNKNOWN & Reconciliation:** For unsupported receivers (`UNSAFE_WRITE`), ambiguous post-crash outcomes are safely transitioned to `UNKNOWN` with a `RECONCILIATION` wait reason, preventing dangerous automated duplicate dispatches.
- **Provider Abstraction:** The harness layer decouples workflow logic from provider-specific wire schemas, providing normalized adapters for OpenAI and Ollama with tool calling and usage tracking.
- **Observability:** Native OpenTelemetry instrumentation exports standardized spans; execution history logs provide an immutable audit trail (`GET /runs/:id/history`).
- **Authentication & Ownership:** SHA-256 bearer tokens with constant-time verification; immutable workflow ownership inherited by runs; owner-scoped endpoints.

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
                        │   OpenAI • Ollama   │               │   Receiver Ledger   │
                        └─────────────────────┘               └─────────────────────┘
```

1. **Express API:** Validates incoming requests, authenticates bearer tokens, manages immutable workflow ownership, and writes run creation keys atomically.
2. **Outbox Dispatcher:** Reads pending dispatches from PostgreSQL and pushes operation job references to BullMQ. If Redis is restarted or flushed, deliveries are rebuilt from PostgreSQL.
3. **Worker:** Receives a job reference, verifies eligibility against PostgreSQL, claims a time-bounded lease, and invokes the operation through the harness.
4. **Harness & Tool Boundary:** Maps model inputs/outputs, enforces tool allowlists, checks capability contracts, and executes deterministic or side-effecting operations.
5. **Atomic Result Commit:** Worker commits operation outputs, creates successor steps, advances run status, and commits the checkpoint in a single PostgreSQL transaction.

---

## 4. Tech Stack

- **Runtime & Language:** Node.js v24+, TypeScript 5.9 (strict ESM)
- **API Framework:** Express 5.1
- **Database & Storage:** PostgreSQL 16 (via `pg` pool, schema migrations in `packages/db`)
- **Queue & Transport:** Redis 7, BullMQ 5.61, `ioredis`
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
│   ├── api/                 # Express 5 control API, auth, scheduler, outbox
│   ├── worker/              # BullMQ worker process, fenced claim, execution
│   └── web/                 # React 19 / Vite operations dashboard
├── packages/
│   ├── config/              # Environment configuration & validation
│   ├── db/                  # PostgreSQL pool, migrations, schema migrations
│   ├── evaluation/          # Multi-process evaluation harness, fault hooks, DBOS runner
│   ├── harness/             # LLM provider registry, adapters (OpenAI, Ollama), tools
│   ├── research/            # Fixed evaluation corpus, cloud-comparison workflow, scripted provider
│   ├── runtime/             # Core durable domain transactions, state machine, leases
│   ├── shared/              # Canonical JSON, queue contracts, shared schemas
│   └── telemetry/           # OpenTelemetry span exporters and attribute schemas
├── evaluation-results/      # Empirical evaluation evidence, logs, manifests, and CSVs
├── tests/
│   ├── unit/                # Unit tests for harness, research workflow, evaluation
│   └── integration/         # Real PostgreSQL + Redis end-to-end integration suite
└── docker-compose.yml       # Local PostgreSQL 16 and Redis 7 services
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
generate-report (DETERMINISTIC / AGENT)
    ↓
approve-publication (APPROVAL GATE - Human Reviewer)
    ↓
publish-report (CONTROLLED SIDE EFFECT - Idempotent Receiver)
```

- **Fixed Deterministic Corpus:** Uses six versioned, immutable provider source records (`cloud-comparison-2026-09-30.v1`, hash `79b076dd...`). This prevents changing live web content from confounding reliability benchmarks.
- **Approval Gate:** The generated Markdown report, source citations, and publication target are cryptographically bound into an approval proposal. The run suspends in `WAITING` until an authorized reviewer (`research-reviewer` role) approves the exact payload hash.
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

AgentFlow was evaluated across real multi-process operating system trials against live PostgreSQL and Redis services, using boundary-level fault injection (`SIGKILL`) at named execution hooks.

### Evaluated Systems
- **B0 (Volatile Baseline):** Standard in-memory agent loop with bounded retries. On crash, process restarts from step 1, repeating all prior work; non-idempotent writes.
- **B1 (Volatile Baseline + Stable Keys):** Restarts from step 1 on crash, but uses a stable receiver key to isolate receiver deduplication from checkpoint recovery.
- **A0 (AgentFlow Ablation):** Full AgentFlow checkpoint durability, but with receiver cooperation disabled (`UNSAFE_WRITE`).
- **A1 (Full AgentFlow Platform):** Full AgentFlow sequential durable runtime with PostgreSQL checkpoints and receiver idempotency contracts.
- **DBOS (Industry Reference):** Matched common subset executed using the official DBOS TypeScript SDK v5.2.11 against a dedicated PostgreSQL database (`agentflow_reference_eval`).

### Injected Fault Scenarios (E0–E7)
- **E0:** No fault (baseline overhead, checkpoint latency).
- **E1:** Late-stage crash at step 6 (`analyze-features`) before operation execution.
- **E2:** Crash after provider response, before local checkpoint commit.
- **E3:** Injected transient provider 503 error (2 retries).
- **E4:** Tool read timeout (50 ms).
- **E5:** Remote success / local crash (worker killed after receiver commit, before step checkpoint).
- **E6:** Unsupported receiver idempotency with post-commit crash.
- **E7:** Worker and API supervisor restart during pending approval.

---

## 9. Results

Empirical results across all executed campaigns:

| Campaign | Systems | Scenarios | Executed Trials | Key Empirical Finding |
|---|---|---|---|---|
| **Primary Real Matrix** | B0, B1, A1 | E0–E7 | **120 trials** (5/cond) | **0 committed re-executions** in A1. A1 skipped 100% of committed inference on late crashes (0 repeated LLM calls vs 5–10 in B0/B1). |
| **Targeted A0 Ablation** | A0 | E0, E5, E6 | **15 trials** (5/cond) | A0 preserves checkpoints but produced **100% duplicate side effects** on E5/E6, proving checkpoint durability alone cannot prevent duplicate actions without receiver cooperation. |
| **DBOS Reference** | DBOS | E0, E1, E2, E5, E7 | **25 trials** (5/cond) | Confirmed that AgentFlow's step durability invariants match an established production framework on the common subset (DBOS recovery: 2.39–2.47s). |
| **Dedicated E5 Safety** | B0, B1, A0, A1 | E5 | **4,000 trials** (1,000/sys) | A1 produced **0 duplicates in 1,000 trials** (Wilson 95% CI: `[0.9962, 1.0000]`), while B0 and A0 duplicated in 1,000/1,000 trials. |
| **Granularity Ablation** | A1 | E0, E1, E5 | **900 trials** (g=1, 2, 4) | Grouping checkpoints across non-side-effecting operations reduced median latency by **8–12%** while retaining 100% duplicate-free safety. |

### Measured Latency & Overhead
- **Checkpoint Commit Latency:** p95 checkpoint latency was **25–34 ms** on local PostgreSQL (well below the 100 ms target).
- **Crash Recovery Latency:** p95 crash-to-dispatch recovery was **1.19–1.23 seconds** with a 1,000 ms lease.
- **Side-Effect Safety on E6:** In unsupported receiver scenarios, A1 safely yielded `UNKNOWN` outcomes with **0 duplicate effects**, whereas B0, B1, and A0 blindly resent and duplicated side effects.

> [!NOTE]
> Token counts in the evaluation matrix are labeled estimates derived from the scripted research provider (`usageProvenance: "estimated-scripted-provider"`, 1.35x word-count model), not billed provider usage.

---

## 10. Demo

The repository includes a fully validated, reproducible end-to-end acceptance demo (`pnpm eval:demo`) exercising the full cloud-comparison research workflow against real PostgreSQL and Redis:

1. **Workflow Initiation:** Workflow starts over the 6-document corpus.
2. **Progress Checkpointing:** First 5 operations (`search-aws` through `analyze-pricing`) commit checkpoints to PostgreSQL.
3. **Fault 1 (Worker Crash):** Worker abruptly killed via `SIGKILL` at `before-operation` on `analyze-features` (PID 23096).
4. **Recovery 1:** Supervisor restarts worker (PID 9580); worker skips 5 committed steps, resumes step 6, and completes feature analysis.
5. **Approval Gate:** Report generated; workflow transitions to `WAITING` state.
6. **Fault 2 (API & Worker Restart):** Both API and worker supervisor processes are terminated while approval is pending.
7. **Recovery 2:** Services restart; pending approval reloads intact from PostgreSQL with matching proposal hash (`32eb1c...`).
8. **Role-Gated Approval:** Reviewer submits approval using bearer token credentials; duplicate approval submission is verified as idempotent.
9. **Fault 3 (Crash after Receiver Commit):** Worker executes `publish-report`; receiver commits payload to `controlled_publication_effects`; worker killed via `SIGKILL` before local checkpoint commit (PID 24072).
10. **Recovery 3:** Supervisor restarts worker (PID 10644); lease expires and is recovered; attempt 2 presents stable idempotency key; receiver deduplicates and returns existing receipt; final checkpoint commits.
11. **Ledger Truth:** Independent receiver ledger confirms exactly 1 publication effect (`duplicateEffects = 0`).

Demo evidence is preserved in [`evaluation-results/real-1791004304094-c27bb567/`](evaluation-results/real-1791004304094-c27bb567/).

---

## 11. Limitations

- **Python Prototype Unimplemented:** An early conceptual Execute → Remember → Control research prototype was described in design documents, but was **not implemented in code** (zero `.py` files exist). The functional implementation is entirely in TypeScript.
- **Live Provider End-to-End Campaigns Deferred:** Provider adapters (`OpenAIResponsesProvider`, `OllamaProvider`) are implemented and pass strict wire-protocol, schema normalization, and usage tests in Vitest. However, live-network end-to-end campaigns against paid external APIs were deferred due to unconfigured API keys and local daemon availability.
- **Primary Matrix Sample Count:** The real process matrix was executed at 5 trials per condition (120 real OS process executions), which conclusively demonstrates deterministic invariant preservation but is descriptive for latency variance.
- **DBOS Sample Count:** The DBOS reference system was evaluated over 25 trials on the common subset.
- **Single-Machine Testbed:** All experiments were conducted on a single host running containerized PostgreSQL and Redis. Distributed cluster partitions and multi-region failovers were outside the MVP scope.
- **Token Count Estimates:** Token figures from the scripted provider are estimates based on word count, not billed provider tokens.

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
# Clone and install dependencies
pnpm install

# Start PostgreSQL and Redis containers
docker compose up -d postgres redis
```

### 2. Database Migrations
```powershell
pnpm db:migrate
```

### 3. Start Development Services
```powershell
# Terminal 1: Start Express API
pnpm dev:api

# Terminal 2: Start BullMQ Worker
pnpm dev:worker

# Terminal 3: Start Operations Console
pnpm dev:web
```
The operations dashboard will be available at `http://localhost:5173`.

### 4. Run Test Suites
```powershell
# Run all unit tests (18 tests)
pnpm test

# Run real PostgreSQL + Redis integration tests (24 tests)
pnpm test:integration

# Run workspace typecheck
pnpm typecheck

# Run production build
pnpm build
```

---

## 14. Evaluation Commands

All evaluation campaigns can be reproduced using existing package scripts:

```powershell
# 1. Run the real acceptance DEMO (10-step cloud comparison with crash recovery)
pnpm eval:demo

# 2. Run the primary real evaluation matrix (B0, B1, A1 across E0–E7)
node --import tsx packages/evaluation/src/real-runner.ts --systems B0,B1,A1 --scenarios E0,E1,E2,E3,E4,E5,E6,E7 --trials 5 --lease-ms 1000 --output evaluation-results/real-primary-matrix

# 3. Run the targeted A0 ablation (E0, E5, E6)
node --import tsx packages/evaluation/src/real-runner.ts --systems A0 --scenarios E0,E5,E6 --trials 5 --lease-ms 1000 --output evaluation-results/real-a0-ablation

# 4. Run the matched DBOS reference campaign
pnpm eval:dbos

# 5. Run the dedicated 1,000-trial E5 side-effect safety benchmark (4,000 trials total)
node --import tsx packages/evaluation/src/cli.ts --systems B0,B1,A0,A1 --scenarios E5 --trials 1000 --output evaluation-results/e5-safety-1000

# 6. Run the checkpoint granularity experiment (900 trials)
node --import tsx packages/evaluation/src/cli.ts --systems A1 --scenarios E0,E1,E5 --granularity 1,2,4 --trials 100 --output evaluation-results/granularity-ablation
```

---

## 15. Evidence

All raw evaluation artifacts are committed and inspectable in [`evaluation-results/`](evaluation-results/):

- **[`real-1791004304094-c27bb567/`](evaluation-results/real-1791004304094-c27bb567/):** Real acceptance DEMO execution artifacts.
- **[`real-primary-matrix/`](evaluation-results/real-primary-matrix/):** 120 primary real process trial records.
- **[`real-a0-ablation/`](evaluation-results/real-a0-ablation/):** 15 real A0 ablation trial records.
- **[`real-dbos-reference/`](evaluation-results/real-dbos-reference/):** 25 real DBOS reference trial records.
- **[`e5-safety-1000/`](evaluation-results/e5-safety-1000/):** 4,000-trial side-effect safety benchmark results.
- **[`granularity-ablation/`](evaluation-results/granularity-ablation/):** 900-trial checkpoint granularity results.

Each experiment directory contains:
- `manifest.json`: Hardware specifications, OS details, git commit hash, corpus hash, seed, and policy parameters.
- `results.jsonl` & `results.csv`: Per-trial raw metrics (latency, recovery time, checkpoint latency, duplicates, LLM calls).
- `summary.json`: Aggregated statistics with Wilson 95% confidence intervals and paired bootstrap differences.
- `evidence.jsonl`: Chronological audit event streams, receipts, and runtime state snapshots.
- `process.log`: Supervisor logs and background lease recovery traces.

---

## 16. Status

- **TypeScript AgentFlow Platform:** **COMPLETE & EMPIRICALLY EVALUATED**  
  All core durable state machines, outbox dispatches, worker lease fencing, role-gated approvals, and receiver contracts are fully implemented and verified with 42 unit/integration tests and clean builds.
- **Research & Evaluation Artifacts:** **COMPLETED FOR THE TYPESCRIPT PLATFORM**  
  Full empirical evidence generated across real process matrices, DBOS reference benchmarks, and large-sample safety suites.
- **Python Execute → Remember → Control Prototype:** **UNIMPLEMENTED / CONCEPTUAL**  
  The Python prototype remains a conceptual research design documented in early design notes; zero Python code exists in this repository.
