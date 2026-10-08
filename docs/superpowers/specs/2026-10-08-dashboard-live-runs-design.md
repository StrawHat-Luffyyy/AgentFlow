# Dashboard: Start and Operate Live Gemini Runs — Design

Date: 2026-10-08
Status: Approved in conversation; pending written-spec review

## 1. Goal

Extend the existing web operations dashboard (`apps/web`) so a signed-in user can start and
operate a real AgentFlow execution from the browser:

```
open AgentFlow → choose workflow/version → choose execution mode → choose Gemini
→ provide JSON input → start run → observe execution → handle approval → inspect result
```

The distinction that must stay visible everywhere:

- **Scripted mode** → deterministic evaluation provider (`scripted-research`)
- **Live mode** → real Google Gemini provider (`gemini`)

The existing dashboard (run rail, detail view, steps, attempts, approvals, usage, history,
1.5 s polling) is **extended, not replaced or redesigned**.

### Success criteria

A user signed into the dashboard, without curl or the CLI, can start a live Gemini run of the
reference workflow, watch it reach `WAITING_APPROVAL`, approve it in the UI, see it reach
`SUCCEEDED`, see real `reported` token usage attributed to the Gemini model, and read the
final report in a Result panel. Scripted and live runs are visually distinguishable in the run
list and run header.

### Decisions

| Topic | Decision |
|---|---|
| Workflow scope | Reference cloud-comparison workflow (guided: mode + provider + model) **plus** the user's own workflow versions (provider/model fixed by the version, shown read-only). No per-run provider override. |
| Provider availability | Workers advertise registered providers via a heartbeat row in Postgres; API aggregates fresh workers. Advisory only — never used to authorize execution. |
| UI placement | `+ New run` button in the Runs rail header opening a right-side drawer; empty state gains a "Start your first run" CTA. |
| Result | New Result panel on `SUCCEEDED` runs showing the report (if present) and final step output. |

### Non-goals (YAGNI)

Live providers other than Gemini in the UI; per-run provider override for user workflows;
editing workflow definitions in the browser; SSE/streaming; token streaming.

## 2. Backend

### 2.1 Worker heartbeats

- **Migration `packages/db/migrations/0013_worker_heartbeats.sql`:**
  ```sql
  CREATE TABLE worker_heartbeats (
    worker_id text PRIMARY KEY,
    providers jsonb NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
  );
  ```
  `providers` is `Array<{ name: string; models: string[] }>`.
- **Advertised providers** are built in the worker, not the harness: `advertisedProviders(registry, models)`
  maps the existing `ProviderRegistry.list()` (which returns provider objects) to
  `{ name, models: models[name] ?? [] }`. The worker passes `{ gemini: [GEMINI_MODEL],
  "scripted-research": ["cloud-comparison-scripted-v1"] }` from its own config. No change to
  `LLMProvider` or `packages/harness`.
- **`packages/runtime/src/index.ts`:**
  - `recordWorkerHeartbeat(db, { workerId, providers })` — upsert; on conflict update
    `providers` and `last_seen_at = now()`; `started_at` set only on insert.
  - `listAvailableProviders(db, { freshWithinMs = 30_000 })` →
    `{ workers: number; providers: Array<{ name; models: string[]; workerCount: number; lastSeenAt: string }> }`
    over rows with `last_seen_at > now() - freshWithinMs`; models are the sorted union across
    workers; providers sorted by name.
- **`apps/worker`:** a heartbeat loop (`startHeartbeat({ database, workerId, providers, intervalMs = 10_000, log })`
  in its own module) writes once at startup and every `intervalMs`; the timer is `unref()`ed;
  failures are logged and never thrown; `stop()` is called during graceful shutdown.
- **Invariant (strictly advisory):** `worker_heartbeats` is readiness information for the UI only.
  It must never authorize, reject, claim, schedule, or otherwise alter durable execution:
  nothing in run creation, claim, lease, execution, retry, scheduling, or repair reads it, and
  `POST /runs` / the reference endpoint never consult it. If a worker disappears after the UI
  reported it available, the run still queues safely in Postgres and executes when an eligible
  worker returns (covered by an integration test, §6).

### 2.2 API (`apps/api/src/app.ts`, thin routes)

- **`GET /runtime/providers`** → `listAvailableProviders(...)`. Authenticated, not owner-scoped
  (infrastructure metadata, no tenant data).
- **`GET /workflows/:id`:** each version gains `providers: string[]` — distinct `provider` values
  of `AGENT` steps in that version's `definition_json`, sorted; `[]` when none.
- **`GET /runs`** (each summary) and **`GET /runs/:id`:** gain `providers: string[]` computed the
  same way from the run's workflow version.
- `POST /runs` and `POST /reference-workflows/cloud-comparison` are unchanged. Reference live
  mode is `{ mode: "live", provider: "gemini", model }`; scripted is `{ mode: "scripted" }`.
  Each combination yields its own immutable workflow version, keeping scripted evaluation
  evidence separate from live runs.

The provider-list SQL fragment (distinct AGENT providers from `definition_json->'steps'`) is
defined once in the runtime and reused by the three queries.

## 3. Web: "New run" drawer

### 3.1 Entry points

- `+ New run` button in the Runs rail header (beside the count).
- The empty state ("No runs yet") gains a primary "Start your first run" button; its copy no
  longer says runs must be created through the API.

### 3.2 Drawer fields (top to bottom)

1. **Workflow** — select. First option is always the synthetic **"Cloud comparison (reference)"**;
   then the user's workflows from `GET /workflows` (name · latest version).
2. **Execution mode** (reference only) — segmented control:
   - **Scripted** — "Deterministic evaluation provider · no API key, no cost"
   - **Live** — "Real Google Gemini calls · uses tokens"
   **Version** (user workflows only) — select from `GET /workflows/:id`, options rendered
   `v{n} · {stepCount} steps · {providers joined, or "no LLM"}`; provider/model are not editable.
3. **Provider / Model** (reference + Live only) — Provider shown read-only as `gemini`;
   Model select populated from `/runtime/providers` entry `gemini.models`.
4. **Readiness line** — from `/runtime/providers` vs the required providers (reference scripted:
   `scripted-research`; reference live: `gemini`; user version: its `providers`):
   - `ok` (green): "{n} worker(s) online · {providers} available"
   - `warn-no-workers` (amber, **does not block**): "No workers online — the run will queue until one starts"
   - `block-missing-provider` (amber, **blocks Start**): "No online worker has {provider} configured — set GEMINI_API_KEY on the worker and restart it" (generic wording for non-gemini providers)
   - Required providers `[]` → `ok` whenever the request succeeds.
5. **Input (JSON)** — monospace textarea, validated live; must be a JSON object; errors shown
   inline with line/column and announced via `aria-live`. Prefill:
   - reference: `{ "publicationTarget": "controlled://publications/dashboard-<yyyymmdd-hhmmss>", "assumptions": { "scope": …, "geography": …, "pricing": … } }`
     (the three default assumption strings from `packages/research/src/runtime.ts`)
   - user workflow: `{}`
   - "Reset to template" restores the prefill.
6. **Advanced** (collapsed) — Creation key (optional, ≤ 200 chars); Deadline in minutes
   (integer 1–1440, default 5 → `deadlineMs`).
7. **Start** — label "Start run" (scripted / user workflow) or "Start live run · Gemini" (live).
   Disabled while input invalid, readiness is `block-missing-provider`, or a request is in flight.

### 3.3 Submit flow

1. Reference: `POST /reference-workflows/cloud-comparison` → `workflowVersionId`.
2. `POST /runs { workflowVersionId, input, creationKey?, deadlineMs }`.
3. On success: close the drawer, refresh runs, select the new run (URL `/runs/:id`); existing
   polling takes over.
4. On failure: keep the drawer open with all field values; inline error — 400 shows the API's
   validation issues, 404 "That workflow version no longer exists", 409 the server message,
   401 triggers the existing session-expired handling, network failure "AgentFlow API is unreachable".

### 3.4 Accessibility and layout

Drawer is a labelled dialog: focus moves in on open and is trapped, Esc and a close button
dismiss it, focus returns to the trigger. All fields have associated labels. On narrow
viewports the drawer becomes full-width.

## 4. Web: observing, approval, result

1. **Mode badge** — derived by `runMode(providers)`: `scripted` when providers is exactly
   `["scripted-research"]` → neutral "Scripted" badge; `live` when any provider other than
   `scripted-research` is present → accent "Live · {provider}" badge; `none` (no AGENT steps)
   → no badge. Shown on rail items and in the run header.
2. **Observing** — unchanged polling and views. Addition: AGENT step rows show the model name
   from that step's usage records when available.
   **Token counts are never estimated or synthesized in the frontend.** Every token figure shown
   (usage tab, Result footer, step hints) is a sum of `inputTokens`/`outputTokens` from persisted
   usage records returned by `GET /runs/:id/usage`; a record with a null count contributes
   nothing and is labelled with its `provenance` as returned by the API. Before any usage
   record exists, the UI shows "No usage recorded yet" rather than a number.
3. **Approval** — unchanged approval card; verified during acceptance to show the payload
   (the generated report) being approved.
4. **Result panel** — rendered only when `publicStatus === "SUCCEEDED"`, above the steps:
   - **Report** — `extractReport(steps)` finds the last step whose `acceptedOutput` (or
     `acceptedOutput.report`) has a string `report.content`; shows `title`, content in a
     `<pre>` (plain text — no HTML/markdown rendering), and `citations` as a list.
   - **Final output** — last step's `acceptedOutput` in the existing `JsonPanel`.
   - **Footer** — token totals grouped by `provider · model`.

## 5. Code organization

- `apps/web/src/new-run.ts` — pure, framework-free logic: `parseRunInput`, `referenceTemplate`,
  `readiness`, `runMode`, `extractReport`, `deadlineMsFromMinutes`, `summarizeUsage`.
- `apps/web/src/NewRunDrawer.tsx` — drawer component (uses `ui.tsx` primitives).
- `apps/web/src/ResultPanel.tsx` — result panel component.
- `apps/web/src/api.ts` — add `listWorkflows`, `getWorkflow`, `runtimeProviders`,
  `setupReference`, `createRun`; add `providers` to `RunSummary`/`RunDetail` types.
- `apps/web/src/App.tsx` — wire the button, drawer, badge, model hint, result panel. No
  restructuring of existing components.
- Styles appended to `apps/web/src/styles.css` using existing tokens.

## 6. Testing and verification

- **Unit (`tests/unit/web-new-run.test.ts`)** — every function in `new-run.ts`, including:
  non-object JSON rejected; syntax error reports line/column; readiness for all three states and
  `[]` required; `runMode` for scripted-only, gemini, mixed, none; `extractReport` for reference
  output, nested `report`, and absent report.
- **Unit (`tests/unit/worker-heartbeat.test.ts`)** — `advertisedProviders` mapping (models
  default to `[]`); heartbeat writes at start and per interval, survives a failing write, stops
  on `stop()` (injected database/timer).
- **Integration (`tests/integration/runtime-providers.test.ts`)** — upsert semantics; stale
  worker excluded; aggregation across two workers; `GET /runtime/providers` requires auth;
  `providers` present on workflow versions, run summaries and run detail. Isolation: unique
  worker/owner IDs, no TRUNCATE.
- **Integration — live reference version contents** — `POST /reference-workflows/cloud-comparison`
  with `{ mode: "live", provider: "gemini", model: <GEMINI_MODEL> }`, then read the persisted
  `workflow_versions.definition_json` directly from Postgres and assert that **every** `AGENT`
  step — specifically `analyze-pricing` and `analyze-features`, and no others — has
  `provider: "gemini"` and `model` equal to the requested model; the scripted version's AGENT
  steps have `provider: "scripted-research"`. Not inferred from UI labels or `providers` summaries.
- **Integration — heartbeats never gate execution** — with no heartbeat rows (or only stale
  ones) for a provider, `POST /runs` still succeeds and the run is `QUEUED`; a worker started
  afterwards executes it to completion. Also asserts no runtime execution module references
  `worker_heartbeats` (grep-style test over `packages/runtime/src` and `apps/worker/src/worker.ts`).
- **Unit — usage display** — `summarizeUsage(records)` (in `new-run.ts`) sums only persisted
  counts, treats null as absent (not zero-estimated), groups by `provider · model`, and returns
  `null` for no records.
- **Browser acceptance (in-app browser, real api + worker + web against `agentflow_test`):**
  1. Scripted: New run → Reference → Scripted → Start → `WAITING_APPROVAL` → Approve →
     `SUCCEEDED`; Result panel shows report; "Scripted" badge.
  2. Live: same with Live / `gemini-3.5-flash`; AGENT steps call real Gemini; usage shows
     `reported` tokens with model; "Live · gemini" badge. (One run; ~2 real Gemini calls —
     approved by the user.)
  3. Readiness: worker without `GEMINI_API_KEY` → Live blocked with guidance.
  4. Narrow viewport drawer check.
- `pnpm typecheck`, `pnpm build` (includes `vite build`), and `pnpm test` green.

## 7. Documentation

- README §13: new subsection "Start a run from the dashboard" — scripted vs live, worker
  `GEMINI_API_KEY` requirement, readiness indicator, Result panel.
- CLAUDE.md: note that `worker_heartbeats` is advisory UI data and must never authorize execution.
- No changes to `evaluation-results/` or evidence claims; dashboard live runs are not
  evaluation evidence and are not described as such.
