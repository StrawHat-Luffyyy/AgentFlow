# AgentFlow — Mentor Brief

**Project title:** AgentFlow — Durable Workflow Runtime for AI Agents.

**One-sentence pitch:** AgentFlow preserves an AI agent's committed progress across failures so long-running tool workflows can resume with controlled retries, durable approvals, and explicit side-effect safety.

**Problem statement:** Ordinary agent loops can lose execution state on process failure and repeat expensive inference or externally visible operations when restarted. An unacknowledged external request also creates uncertainty about whether an action happened.

**Motivation:** Multi-step agent applications interact with unreliable APIs, incur repeated inference cost, and may wait for human decisions. Reliability should be managed by an execution layer with inspectable guarantees.

**Objectives:** Persist workflow progress; recover unfinished operations; prevent stale local commits; bound retries/timeouts; preserve approval decisions; reuse results; support two LLM providers; measure reliability, repeated work, and duplicate effects under injected faults.

**Proposed solution:** A TypeScript runtime uses PostgreSQL for state, checkpoints, attempts, approvals, and dispatch intent. Workers receive operation references through Redis/BullMQ, claim execution in PostgreSQL, call permitted models/tools, and commit results atomically. A harness separates model decisions from execution control.

**Research gap and novelty:** Existing systems already provide durable execution and durable agents. This project investigates a restricted implementation and a reproducible benchmark of checkpoint cost, ambiguous external outcomes, and approval safety. Its contribution is transparent engineering evidence, not inventing durability.

**Architecture summary:** Client/SDK → API/control engine → PostgreSQL state/outbox → queue → workers/harness → providers/tools → atomic result/checkpoint → history and metrics.

**Technology stack:** Node.js and TypeScript; Express for one API; PostgreSQL; Redis-backed BullMQ; Docker Compose; OpenTelemetry; React with a lightweight build setup (Vite) for the dashboard. Use one database library the team already knows. Next.js is optional if familiar, but it should not introduce a second execution backend.

**Implementation status:** The repository implements the complete TypeScript durable platform/runtime (`@agentflow/runtime`, `@agentflow/harness`, `@agentflow/db`, `@agentflow/research`, `@agentflow/evaluation`, `apps/api`, `apps/worker`, `apps/web`). The separate Python Execute → Remember → Control research prototype discussed in conceptual documents was not implemented in code and remains an uninstantiated conceptual design.

**Expected outcome:** A demonstrable runtime that recovers an interrupted research workflow, reuses committed outputs, waits safely for approval, and prevents duplicate effects when the receiver supports idempotency. Unsupported uncertain effects remain visibly blocked.

**Evaluation approach & empirical status:**
- Verified with real multi-process supervisor over PostgreSQL (`agentflow_acceptance_eval`) and Redis:
  - **Full acceptance DEMO:** Passed with 2 crash boundaries, API and worker restart across a pending approval, and exactly one receiver effect for the publication (re-run successfully during the final audit, approved through the dashboard).
  - **Real primary matrix:** 120 trials across B0, B1, A1 and E0–E7 (5 trials/condition). A1 had 0 committed re-executions and 0 duplicate effects in all 40 trials. On E6 (unsupported receiver idempotency), A1 halted in `UNKNOWN` in 5/5 trials without resending.
  - **Real A0 ablation:** 15 trials on E0, E5, E6; durability without receiver cooperation duplicated the effect in 5/5 E5 and 5/5 E6 trials.
  - **Matched DBOS reference:** 25 trials on E0, E1, E2, E5, E7 with DBOS SDK 5.2.11 against `agentflow_reference_eval`.
- **Simulator (modelled, not runtime evidence):** a deterministic seeded model produced a 4,000-trial E5 sweep (0 modelled duplicates for A1) and a 900-trial checkpoint-granularity study (7–12% lower modelled latency with grouping). These explore design trade-offs only; grouping is not implemented in the runtime.
- **Limitations:** Five real trials per condition show the invariants held in every observed run but cannot bound rare failure rates; token counts are labeled estimates from the deterministic scripted provider; provider adapters are verified by protocol tests, but live-network end-to-end campaigns were not run; single-machine testbed.

**Demo narrative:** Start a cloud-comparison report; show five committed steps; kill the worker during feature analysis; restart and resume from the unfinished operation; pause for human approval across another restart; publish once despite a crash after receiver acceptance. Show the independent receiver ledger.

**Feasibility statement:** Two students, 12 weeks, one sequential workflow family, one bounded agent loop, two providers, and a basic dashboard. The first success criterion is recovery correctness; interface polish follows it.

Detailed architecture, literature matrix, source citations, and experiment definitions are in the companion AgentFlow Research and Architecture report.
