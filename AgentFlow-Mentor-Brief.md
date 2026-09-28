# AgentFlow — Mentor Brief

**Project title:** AgentFlow — Durable Workflow Runtime for AI Agents.

**One-sentence pitch:** AgentFlow preserves an AI agent's committed progress across failures so long-running tool workflows can resume with controlled retries, durable approvals, and explicit side-effect safety.

**Problem statement:** Ordinary agent loops can lose execution state on process failure and repeat expensive inference or externally visible operations when restarted. An unacknowledged external request also creates uncertainty about whether an action happened.

**Motivation:** Multi-step agent applications interact with unreliable APIs, incur repeated inference cost, and may wait for human decisions. Reliability should be managed by an execution layer with inspectable guarantees.

**Objectives:** Persist workflow progress; recover unfinished operations; prevent stale local commits; bound retries/timeouts; preserve approval decisions; reuse results; support two LLM providers; measure reliability, repeated work, and duplicate effects under injected faults.

**Proposed solution:** A TypeScript runtime uses PostgreSQL for state, checkpoints, attempts, approvals, and dispatch intent. Workers receive operation references through Redis/BullMQ, claim execution in PostgreSQL, call permitted models/tools, and commit results atomically. A harness separates model decisions from execution control.

**Research gap and novelty:** Existing systems already provide durable execution and durable agents. This project investigates a restricted implementation and a reproducible benchmark of checkpoint cost, ambiguous external outcomes, and approval safety. Its contribution is transparent engineering evidence, not inventing durability.

**Architecture summary:** Client/SDK → API/control engine → PostgreSQL state/outbox → queue → workers/harness → providers/tools → atomic result/checkpoint → history and metrics.

**Technology stack:** Node.js and TypeScript; Fastify for one API; PostgreSQL; Redis-backed BullMQ; Docker Compose; OpenTelemetry; React with a lightweight build setup for the dashboard. Use one database library the team already knows. Next.js is optional if familiar, but it should not introduce a second execution backend.

**Expected outcome:** A demonstrable runtime that recovers an interrupted research workflow, reuses committed outputs, waits safely for approval, and prevents duplicate effects when the receiver supports idempotency. Unsupported uncertain effects remain visibly blocked.

**Evaluation approach:** Compare an ordinary retry-enabled volatile agent, AgentFlow, and one existing durable reference on controlled faults. Measure completion, recovery latency, repeated calls/tokens, runtime overhead, duplicate/missing effects, and approval correctness.

**Demo narrative:** Start a cloud-comparison report; show five committed steps; kill the worker during feature analysis; restart and resume from the unfinished operation; pause for human approval across another restart; publish once despite a crash after receiver acceptance. Show the independent receiver ledger.

**Feasibility statement:** Two students, 12 weeks, one sequential workflow family, one bounded agent loop, two providers, and a basic dashboard. The first success criterion is recovery correctness; interface polish follows it.

Detailed architecture, literature matrix, source citations, and experiment definitions are in the companion AgentFlow Research and Architecture report.
