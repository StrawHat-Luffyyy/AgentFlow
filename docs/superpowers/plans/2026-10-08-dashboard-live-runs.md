# Dashboard Live Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a dashboard user start, watch, approve and inspect scripted or live-Gemini runs from the browser, with worker-advertised provider readiness.

**Architecture:** Workers upsert an advisory `worker_heartbeats` row listing their providers; the API exposes `GET /runtime/providers` and adds `providers: string[]` (distinct AGENT-step providers) to workflow versions and runs. The web app gains a "New run" drawer, a Scripted/Live badge, an AGENT-step model hint and a Result panel; all decision logic lives in a pure `new-run.ts` module that is unit-tested.

**Tech Stack:** TypeScript strict ESM, Express 5, pg, BullMQ, React 19 + Vite 7, lucide-react, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-dashboard-live-runs-design.md` — field copy, readiness messages, badge rules and Result panel rules are defined there and not repeated here.

## Global Constraints

- `worker_heartbeats` is advisory: no code in `packages/runtime` execution paths (create/claim/lease/complete/fail/schedule/repair), `apps/worker/src/worker.ts`, `POST /runs`, or the reference endpoint may read it.
- Token counts in the UI come only from `GET /runs/:id/usage` records; null counts contribute nothing; no frontend estimation.
- Migrations are append-only: new file `0013_worker_heartbeats.sql`; never edit applied ones.
- Domain SQL goes in `packages/runtime/src/index.ts`; routes stay thin.
- Freshness window 30 000 ms; heartbeat interval 10 000 ms; deadline minutes 1–1440 default 5; creation key ≤ 200 chars.
- Report content is rendered as plain text (`<pre>`), never as HTML.
- Do not restructure existing `App.tsx` components; add new components in new files.
- Integration tests: unique IDs, no TRUNCATE, keep the `_test` DB-name guard.
- Live Gemini calls happen only in the single browser acceptance run (Task 7), never in automated tests.

## Review Focus

1. **Worker vanishes after UI says "available"** — run must queue and later execute. Test in Task 1.
2. **Heartbeat write fails (DB blip)** — worker keeps processing jobs; no crash. Test in Task 3.
3. **User pastes non-object JSON / trailing comma** — Start disabled with line/column error, no request sent. Test in Task 4.
4. **`/runtime/providers` request fails** — drawer must not block scripted/user runs; readiness shows "unknown" non-blocking. Test in Task 4 (`readiness` with `availability === null`).
5. **Usage records with null token counts or `estimated` provenance** — shown as-is with provenance, never filled in. Test in Task 4.

---

### Task 1: Heartbeat storage, `/runtime/providers`, advisory guarantee

**Files:**
- Create: `packages/db/migrations/0013_worker_heartbeats.sql`
- Modify: `packages/runtime/src/index.ts` (add `recordWorkerHeartbeat`, `listAvailableProviders`)
- Modify: `apps/api/src/app.ts` (`GET /runtime/providers`)
- Test: `tests/integration/runtime-providers.test.ts`

**Interfaces:**
- Produces: `type AdvertisedProvider = { name: string; models: string[] }`; `recordWorkerHeartbeat(db: Queryable, input: { workerId: string; providers: AdvertisedProvider[] }): Promise<void>`; `listAvailableProviders(db: Queryable, options?: { freshWithinMs?: number }): Promise<{ workers: number; providers: Array<{ name: string; models: string[]; workerCount: number; lastSeenAt: string }> }>`; HTTP `GET /runtime/providers` → same shape.

- [ ] **Step 1: Write failing tests** (setup copied from `cli-endpoints.test.ts`; worker/outbox setup from `cli.test.ts`):
  - upsert: two `recordWorkerHeartbeat` calls for `hb-<uuid>` keep one row, `started_at` unchanged, `last_seen_at` advanced, providers replaced.
  - stale exclusion: a row updated to `last_seen_at = now() - interval '31 seconds'` is not counted.
  - aggregation: workers A `{gemini:[m1]}` and B `{gemini:[m2], scripted-research:[s]}` → gemini `workerCount 2`, `models ["m1","m2"]` (filter to rows with this test's unique worker IDs by using a unique provider name prefix, e.g. `gemini-<uuid>`).
  - `GET /runtime/providers` without auth → 401; with token → 200 with `workers` number.
  - **advisory**: with no fresh heartbeat for the run's workflow, `POST /runs` for a DETERMINISTIC-only workflow → 201 and `publicStatus: "QUEUED"`; then start a worker (`createOperationWorker`) + outbox dispatcher on a unique queue name and wait for `SUCCEEDED` (≤ 15 s).
  - **advisory static check**: read `packages/runtime/src/index.ts` and assert the only functions whose bodies mention `worker_heartbeats` are `recordWorkerHeartbeat` and `listAvailableProviders`; read `apps/worker/src/worker.ts` and assert it does not contain `worker_heartbeats`.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/integration/runtime-providers.test.ts` — FAIL (functions/route missing).
- [ ] **Step 3: Implement** migration, runtime functions (models union sorted; providers sorted by name; `lastSeenAt` = max across workers as ISO), route.
- [ ] **Step 4: Run** test — PASS; `pnpm typecheck` clean.
- [ ] **Step 5: Commit** `feat(runtime): add advisory worker heartbeats and provider availability endpoint`.

### Task 2: `providers` on versions and runs; live reference version contents

**Files:**
- Modify: `packages/runtime/src/index.ts` (`getWorkflow`, `listRuns`, `getRun`)
- Test: `tests/integration/runtime-providers.test.ts` (new `describe` blocks)

**Interfaces:**
- Produces: `providers: string[]` on `getWorkflow(...).versions[]`, on each `listRuns(...).runs[]`, and on `getRun(...)`. One shared SQL expression, e.g. a module-level constant `AGENT_PROVIDERS_SQL(alias)` returning
  `COALESCE((SELECT array_agg(DISTINCT s->>'provider' ORDER BY s->>'provider') FROM jsonb_array_elements(<alias>.definition_json->'steps') s WHERE s->>'kind' = 'AGENT'), '{}')`.

- [ ] **Step 1: Write failing tests:**
  - **live reference contents**: `POST /reference-workflows/cloud-comparison` `{mode:"live", provider:"gemini", model:"gemini-3.5-flash"}` as a unique owner → read `definition_json` for the returned `workflowVersionId` straight from Postgres; collect AGENT steps; assert their keys are exactly `["analyze-pricing","analyze-features"]` and each has `provider === "gemini"` and `model === "gemini-3.5-flash"`. Same for `{mode:"scripted"}` → `provider === "scripted-research"`.
  - `GET /workflows/:id` for the live reference workflow → `versions[0].providers` equals `["gemini"]`; a DETERMINISTIC-only workflow → `[]`.
  - `GET /runs` item and `GET /runs/:id` for a run of the live version → `providers: ["gemini"]` (create the run; it will just queue — no Gemini call is made because no worker with gemini consumes this test's queue).
- [ ] **Step 2: Run** — FAIL (`providers` undefined).
- [ ] **Step 3: Implement** the shared expression and add it to the three queries (`getRun` joins `workflow_versions`).
- [ ] **Step 4: Run** this file plus `tests/integration/cli-endpoints.test.ts` and `tests/integration/durable-path.test.ts` with `--no-file-parallelism` — PASS; `pnpm typecheck` clean.
- [ ] **Step 5: Commit** `feat(runtime): expose AGENT providers on workflow versions and runs`.

### Task 3: Worker heartbeat loop

**Files:**
- Create: `apps/worker/src/heartbeat.ts`
- Modify: `apps/worker/src/main.ts` (start after worker creation; `stop()` first in `shutdown`)
- Test: `tests/unit/worker-heartbeat.test.ts`

**Interfaces:**
- Consumes: `recordWorkerHeartbeat`, `AdvertisedProvider` (Task 1); `ProviderRegistry.list()` (existing, returns `LLMProvider[]`).
- Produces: `advertisedProviders(registry: ProviderRegistry, models: Record<string, string[]>): AdvertisedProvider[]`; `startHeartbeat(options: { write: (providers: AdvertisedProvider[]) => Promise<void>; providers: AdvertisedProvider[]; intervalMs?: number; log?: (message: string, error: unknown) => void; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval }): { stop(): void; ready: Promise<void> }` — `ready` resolves after the first write attempt (success or logged failure).

- [ ] **Step 1: Write failing tests:** `advertisedProviders` maps names and defaults models to `[]`; `startHeartbeat` with fake timers writes once immediately and once per `intervalMs`; a rejecting `write` is logged via `log` and the next tick still writes; `stop()` prevents further writes.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/worker-heartbeat.test.ts` — FAIL.
- [ ] **Step 3: Implement**; in `main.ts` pass models `{ gemini: [config.GEMINI_MODEL], "scripted-research": ["cloud-comparison-scripted-v1"] }`, `write` = `recordWorkerHeartbeat(database, { workerId: config.WORKER_ID, providers })`, `log` = `console.error`; timer `unref()`ed.
- [ ] **Step 4: Run** — PASS; `pnpm typecheck` clean.
- [ ] **Step 5: Commit** `feat(worker): advertise registered providers via heartbeat`.

### Task 4: Web pure logic (`new-run.ts`)

**Files:**
- Create: `apps/web/src/new-run.ts`
- Test: `tests/unit/web-new-run.test.ts`

**Interfaces:**
- Produces:
  - `parseRunInput(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string }` — error text includes `line L, column C` for syntax errors (computed from the `position N` in the engine message, or by scanning; fall back to message alone), and `"Input must be a JSON object"` for arrays/primitives/null.
  - `referenceTemplate(now: Date): string` — pretty JSON (2 spaces) with `publicationTarget: "controlled://publications/dashboard-<yyyymmdd-hhmmss>"` (UTC) and the three default assumptions copied from `packages/research/src/runtime.ts`.
  - `type Availability = { workers: number; providers: Array<{ name: string; models: string[]; workerCount: number }> }`
  - `readiness(required: string[], availability: Availability | null): { state: "ok" | "unknown" | "warn-no-workers" | "block-missing-provider"; message: string; blocking: boolean }` — `null` → `unknown`, non-blocking ("Worker availability unknown — the run will queue until a worker picks it up"); `workers === 0` → `warn-no-workers`; any required provider absent → `block-missing-provider` (gemini message from spec; others generic); else `ok`.
  - `runMode(providers: string[] | undefined): { kind: "scripted" } | { kind: "live"; provider: string } | { kind: "none" }` — live provider = first non-`scripted-research`.
  - `extractReport(steps: Array<{ acceptedOutput: unknown }>): { title: string; content: string; citations: string[] } | null` — last step whose `acceptedOutput.report.content` is a string.
  - `deadlineMsFromMinutes(text: string): { ok: true; value: number } | { ok: false; error: string }` — integer 1–1440.
  - `summarizeUsage(records: Array<{ provider: string; model: string; provenance: string; inputTokens: number | null; outputTokens: number | null }>): null | { input: number; output: number; groups: Array<{ label: string; input: number; output: number; provenances: string[] }> }` — `null` for empty; nulls add 0 and are not replaced by estimates; label `"<provider> · <model>"`.

- [ ] **Step 1: Write failing tests** covering every bullet above, including: `[]`, `"x"`, `null` → object error; `{"a":1,}` → error containing `line 1`; readiness `required ["gemini"]` with `{workers:1, providers:[{name:"scripted-research",…}]}` → blocking; `{workers:0}` → non-blocking; `null` → `unknown` non-blocking; `required []` with workers → ok; `runMode(["scripted-research"])` scripted, `["gemini","scripted-research"]` live gemini, `[]`/`undefined` none; `extractReport` on the reference shape `{ report: { title, content, citations } }`; `summarizeUsage` with a `{inputTokens:null}` record keeps total from others and lists provenance `estimated`.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/web-new-run.test.ts` — FAIL.
- [ ] **Step 3: Implement** (no React, no DOM, no `import.meta.env`).
- [ ] **Step 4: Run** — PASS; `pnpm --filter @agentflow/web typecheck` clean.
- [ ] **Step 5: Commit** `feat(web): add run-start, readiness, mode and result logic`.

### Task 5: API client additions and New Run drawer

**Files:**
- Modify: `apps/web/src/api.ts` (types + `listWorkflows`, `getWorkflow`, `runtimeProviders`, `setupReference`, `createRun`; `providers?: string[]` on `RunSummary`/`RunDetail`)
- Create: `apps/web/src/NewRunDrawer.tsx`
- Modify: `apps/web/src/App.tsx` (rail-header button, empty-state CTA, drawer mount, select new run), `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 4 functions; existing `Button`, `InlineAlert`, `Tabs`-style segmented markup from `ui.tsx`.
- Produces: `<NewRunDrawer open onClose onStarted={(runId: string) => void} onSessionExpired />`.

- [ ] **Step 1: Verify-first check** — no DOM test stack exists (ledgered ruling): the drawer's decisions are Task 4 functions; this task's checks are `pnpm --filter @agentflow/web build` and the Task 7 browser run.
- [ ] **Step 2: Implement** API methods and the drawer per spec §3 (fields, readiness line, Start label, submit flow, error mapping, focus trap/Esc/return focus, full-width under 640 px). Poll `/runtime/providers` on open and every 5 s while open.
- [ ] **Step 3: Wire** into `App.tsx`; on `onStarted` refresh runs and `selectRun(id)`.
- [ ] **Step 4: Run** `pnpm --filter @agentflow/web build` and `pnpm typecheck` — clean.
- [ ] **Step 5: Commit** `feat(web): add New run drawer for scripted and live Gemini runs`.

### Task 6: Mode badge, model hint, Result panel

**Files:**
- Create: `apps/web/src/ResultPanel.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `runMode`, `extractReport`, `summarizeUsage` (Task 4); `UsageRecord` (existing).
- Produces: `<ModeBadge providers />` (in `ResultPanel.tsx` or its own small export), `<ResultPanel run usage />`.

- [ ] **Step 1: Implement** badge on rail items + run header; AGENT step rows show model(s) from `usage.filter(u => u.stepId === step.id)` (distinct `model`), nothing when none; Result panel only when `publicStatus === "SUCCEEDED"` per spec §4.4, footer from `summarizeUsage` (shows "No usage recorded" when `null`).
- [ ] **Step 2: Run** `pnpm --filter @agentflow/web build`, `pnpm typecheck` — clean.
- [ ] **Step 3: Commit** `feat(web): show run mode, step model and final result`.

### Task 7: Docs and browser acceptance

**Files:**
- Modify: `README.md` (§13 subsection "Start a run from the dashboard"; update test counts to measured), `CLAUDE.md` (advisory heartbeat note)

- [ ] **Step 1: Docs** per spec §7.
- [ ] **Step 2: Full suite** `pnpm typecheck`, `pnpm build`, `pnpm test` — green.
- [ ] **Step 3: Browser acceptance** against api (port 3099) + worker + `pnpm dev:web` on `agentflow_test` with a throwaway admin password / token: (a) scripted run end-to-end incl. approval and Result panel; (b) **one** live Gemini run end-to-end, confirming `reported` usage with model; (c) restart worker with `GEMINI_API_KEY=` empty → Live blocked with guidance, scripted still allowed; (d) narrow viewport drawer. Stop all servers afterwards.
- [ ] **Step 4: Commit** `docs: document starting scripted and live runs from the dashboard`.
