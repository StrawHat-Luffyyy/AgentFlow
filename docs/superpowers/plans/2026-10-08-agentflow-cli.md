# AgentFlow CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an `agentflow` terminal CLI (new `apps/cli` package) that drives a running AgentFlow API with parity to the web dashboard, plus three read-only API endpoints it needs.

**Architecture:** Thin Commander CLI. `run(argv, io)` is the testable entry and returns an exit code; commands orchestrate `ApiClient` (the only HTTP code, zod-validated responses) and `emit` (JSON vs human rendering). Server additions live in `packages/runtime/src/index.ts` with thin routes in `apps/api/src/app.ts`.

**Tech Stack:** TypeScript (strict ESM, NodeNext), Node 24 (`fetch`, `node:util` `styleText`, `node:readline`), `commander@^14`, `zod@3.23.8`, `@agentflow/shared`, `tsx`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-agentflow-cli-design.md` — read it alongside this plan; command semantics, exit codes, message copy, and output rules are defined there and not repeated here.

## Global Constraints

- CLI runtime dependencies are exactly: `commander`, `zod` (`3.23.8`, matching the repo), `@agentflow/shared` (`workspace:*`), `tsx` (needed by the bin shim until the bundle step). No other runtime deps; no native modules.
- CLI never imports `@agentflow/runtime`, `@agentflow/db`, `@agentflow/research`, or anything under `apps/api` (bundle-readiness). Tests may.
- Same tsconfig strictness as the repo (`extends ../../tsconfig.json`); ESM imports use `.js` suffixes like other packages.
- `run()` never calls `process.exit` and never touches `process.*` directly — only through `CliIO`. Only `src/main.ts` touches `process`.
- stdout carries data only; prompts, progress, warnings, verbose logs and errors go to stderr.
- Secrets (bearer tokens, session IDs, passwords) never appear in stdout, stderr, verbose logs, or error messages.
- Exit codes exactly as spec §2 table: 0,1,2,3,4,5,10,11,12,13,14,130.
- Default base URL `http://localhost:3000`; default watch interval `2s`; transient backoff cap `30s`; short-ID min length `8`.
- Durations accept `<int>(ms|s|m|h|d)` only; a bare number is a usage error.
- New domain SQL goes in `packages/runtime/src/index.ts`, not route handlers. No migrations.
- Integration tests must not TRUNCATE shared tables (other integration files run in parallel on the same `agentflow_test` DB); isolate via unique credential IDs and `randomUUID()`-suffixed workflow names, and call the existing `_test` name guard.

## Review Focus

1. **Expired / revoked session mid-use** — a stored session that the server rejects must yield exit 3 and "Session expired — run `agentflow login`", not a stack trace. Test in Task 4.
2. **Piped / non-TTY usage** — `agentflow runs cancel x | cat` or CI with no `--yes` must refuse with exit 2 rather than hang on a prompt; `login` without TTY and without `--token` must refuse rather than hang. Tests in Tasks 5 and 7.
3. **API unreachable or wrong URL** — connection refused must print "Cannot reach AgentFlow API at <url> — is it running?" with exit 1; `watch` must instead back off and keep trying on network/5xx. Tests in Tasks 4 and 8.
4. **Approval content tampering / drift** — if the server's `proposalHash`/`payloadHash` don't equal `sha256(canonicalJson(...))` of the shown content, `approve` must refuse (exit 1) rather than sign. Test in Task 9.
5. **Corrupt or hand-edited config file** — invalid JSON or schema must produce an error naming the file path (exit 1), never silently overwrite. Test in Task 3.

---

### Task 1: Server endpoints — list/get workflows, pending approvals

**Files:**
- Modify: `packages/runtime/src/index.ts` (add three exported functions near `listRuns`/`getRunApprovals`)
- Modify: `apps/api/src/app.ts` (three routes, beside existing `/workflows` and `/approvals` routes; import the new functions)
- Test: `tests/integration/cli-endpoints.test.ts`

**Interfaces:**
- Produces (runtime):
  - `listWorkflows(database: Queryable, options: { ownerId: string }): Promise<{ workflows: Array<{ id: string; name: string; description: string; createdAt: Date; latestVersion: number | null; versionCount: number }> }>` — ordered `created_at DESC, id DESC`.
  - `getWorkflow(database: Queryable, workflowId: string): Promise<{ id; name; description; createdAt; versions: Array<{ id: string; version: number; createdAt: Date; stepCount: number }> }>` — versions ordered by `version`; `stepCount = jsonb_array_length(definition_json->'steps')`; throws `NotFoundError("Workflow not found")`.
  - `listPendingApprovals(database: Queryable, options: { ownerId: string; roles: readonly string[]; runId?: string }): Promise<Array<ApprovalRow>>` — same columns/aliases as `getRunApprovals` (which already include `runId`); predicate `status = 'PENDING' AND expires_at > now() AND reviewer_role = ANY($roles) AND w.owner_id = $owner [AND run_id = $run]`; ordered `created_at, id`.
- Produces (HTTP): `GET /workflows` → `{ workflows }`; `GET /workflows/:id` → workflow object; `GET /approvals?runId=<uuid>` → `{ approvals }` (query parsed with `z.object({ runId: z.string().uuid().optional() })`).

- [ ] **Step 1: Write failing integration test** `tests/integration/cli-endpoints.test.ts`, using the `session-auth.test.ts` setup pattern (createApp on port 0, own Queue name `cli-endpoints-queue`), with credentials:
  `cli-ep-owner-<uuid>` roles `["release-manager"]` token A; same id with roles `[]` token B; `cli-ep-other-<uuid>` roles `["release-manager"]` token C. Cases:
  - `GET /workflows` with A after creating two workflows (unique names) and publishing v1 on one → both returned, the published one has `latestVersion: 1, versionCount: 1`, the other `latestVersion: null, versionCount: 0`; with C → neither of A's workflows present.
  - `GET /workflows/:id` with A → `versions[0]` has `version: 1` and `stepCount: 2`; with C → 404 `{ error: "NOT_FOUND" }`; with random UUID → 404; with `not-a-uuid` → 400.
  - Approval workflow (steps: APPROVAL `review` reviewerRole `release-manager` expiresAfterMs 60000, then DETERMINISTIC `finalize`, copied from `createApprovalRun` in `durable-path.test.ts`), start a run with A: `GET /approvals` with A → contains one item with that `runId` and `status: "PENDING"`, has `proposalHash`; with B (no roles) → empty; with C → no item for that run; `GET /approvals?runId=<run>` with A → exactly that run's approval; `?runId=bad` → 400.
  - Expired approval (expiresAfterMs 1000, wait ~1.2s) → not listed.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/integration/cli-endpoints.test.ts` — expected FAIL (404 / route missing).
- [ ] **Step 3: Implement** the three runtime functions and routes. Routes read `response.locals.principal` for `ownerId`/`roles`; `GET /workflows/:id` relies on the existing ownership middleware.
- [ ] **Step 4: Run** the test file — expected PASS. Run `pnpm exec vitest run tests/integration/durable-path.test.ts tests/integration/session-auth.test.ts` — expected PASS (no regressions). Run `pnpm typecheck` — clean.
- [ ] **Step 5: Commit** `feat(api): add workflow listing/detail and pending-approvals endpoints`.

### Task 2: CLI package scaffold, `run()`, errors, output primitives

**Files:**
- Create: `apps/cli/package.json`, `apps/cli/tsconfig.json`, `apps/cli/bin/agentflow.js`
- Create: `apps/cli/src/main.ts`, `src/run.ts`, `src/io.ts`, `src/errors.ts`
- Create: `apps/cli/src/output/style.ts`, `output/table.ts`, `output/duration.ts`, `output/emit.ts`
- Modify: root `package.json` (script `"agentflow": "pnpm --filter @agentflow/cli exec agentflow"`)
- Test: `tests/unit/cli-output.test.ts`, `tests/unit/cli-helpers.ts` (shared test helper)

**Interfaces:**
- Produces:
  - `io.ts`: `interface CliIO { stdout: Writable & { isTTY?: boolean; columns?: number }; stderr: Writable & { isTTY?: boolean }; stdin: Readable & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown }; env: Record<string, string | undefined>; platform: NodeJS.Platform; homedir: string; fetch: typeof fetch; sleep: (ms: number, signal?: AbortSignal) => Promise<void>; now: () => number; signal: AbortSignal }`.
  - `errors.ts`: `const ExitCode = { OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, NOT_FOUND: 4, CONFLICT: 5, RUN_FAILED: 10, RUN_CANCELLED: 11, RUN_WAITING: 12, WATCH_TIMEOUT: 13, RUN_TIMED_OUT: 14, INTERRUPTED: 130 } as const`; `class CliError extends Error { constructor(message: string, readonly exitCode: number, readonly code: string, readonly details?: unknown) }`; `class UsageError extends CliError` (exit 2, code `"USAGE"`).
  - `output/style.ts`: `colorEnabled(io: CliIO, flag: boolean): boolean` (false when flag false, `NO_COLOR` set, `TERM=dumb`, or `!io.stdout.isTTY`); `paintStatus(status: string, color: boolean): string` (colors per spec §6 via `styleText`).
  - `output/table.ts`: `renderTable(columns: Array<{ header: string; get: (row: T) => string; max?: number }>, rows: T[], width: number): string` — header row + rows, columns separated by two spaces, cells truncated with `…` to `max`, last column truncated to fit `width`; ANSI codes excluded from width calculation.
  - `output/duration.ts`: `parseDuration(text: string): number` (throws `UsageError`); `formatRelative(iso: string | Date, now: number): string` (`"just now"` <10s, `"42s ago"`, `"3m ago"`, `"2h ago"`, `"5d ago"`; future → `"in 3m"`).
  - `output/emit.ts`: `class Output { constructor(io: CliIO, opts: { json: boolean; quiet: boolean; color: boolean; verbose: boolean }); readonly opts; readonly width: number /* stdout.columns ?? 100 */; data(value: unknown, human: { render: () => string; ids?: () => string[] }): void; info(message: string): void /* stderr, suppressed by quiet */; warn(message: string): void; debug(message: string): void /* stderr only when verbose */; }`. `data`: json → `JSON.stringify(value, null, tty ? 2 : 0)`; quiet with `ids` → ids one per line; else `render()`.
  - `run.ts`: `run(argv: string[], io: CliIO): Promise<number>` — builds Commander program `agentflow` with global options `--profile <name>`, `--url <url>`, `--json`, `--no-color`, `-q, --quiet`, `-v, --verbose`, `--version` (from package.json); uses `exitOverride()` and `configureOutput` writing to `io.stdout`/`io.stderr`; help/version → 0, Commander parse errors → 2; catches `CliError` → message on stderr (+ `{"error":{code,message,status?,details?}}` line on stderr when `--json`) and its exitCode; unknown errors → "Unexpected error: <message>" exit 1 (stack only with `-v`). Exposes `registerCommands(program, getContext)` hook point that later tasks fill in from `commands/*.ts`.
  - `main.ts`: builds real `CliIO` from `process`, wires `SIGINT` to an `AbortController`, `process.exitCode = await run(process.argv.slice(2), io)`.
  - `bin/agentflow.js`: `#!/usr/bin/env node`; `import { register } from "tsx/esm/api"; register(); await import("../src/main.ts");`
  - `tests/unit/cli-helpers.ts`: `fakeIO(overrides?): { io: CliIO; stdout(): string; stderr(): string; feed(text: string): void }` using `PassThrough` streams, `isTTY` false by default, injectable `fetch`, instant `sleep`, fixed `now`; `startFakeApi(handler: (req: { method; path; query; headers; body }) => { status: number; body?: unknown; headers?: Record<string,string> }): Promise<{ url: string; requests: Array<...>; close(): Promise<void> }>` using `node:http` on port 0.

- [ ] **Step 1: Write failing tests** in `tests/unit/cli-output.test.ts`:
  - `parseDuration`: `"500ms"→500`, `"90s"→90000`, `"5m"→300000`, `"1h"→3600000`, `"2d"→172800000`; `"5"`, `"5x"`, `""`, `"-1s"` throw `UsageError`.
  - `formatRelative` with fixed now: 5s→`"just now"`, 42s→`"42s ago"`, 180s→`"3m ago"`, 7200s→`"2h ago"`, future 180s→`"in 3m"`.
  - `colorEnabled`: false for non-TTY; false when `NO_COLOR=1` on TTY; false when `TERM=dumb`; false when flag false; true for TTY otherwise.
  - `renderTable` at width 40 with a long last column → every line `≤ 40` chars and truncated cell ends with `…`; colored cells don't inflate width.
  - `run(["--version"])` → exit 0, stdout is the package version; `run(["--help"])` → exit 0, stdout contains `Usage: agentflow`; `run(["nonsense"])` → exit 2, stderr non-empty, stdout empty.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/cli-output.test.ts` — FAIL (modules missing).
- [ ] **Step 3: Implement** package files and modules above; `pnpm install` to link the workspace package and add `commander`.
- [ ] **Step 4: Run** the test — PASS; `pnpm --filter @agentflow/cli typecheck` — clean; `pnpm agentflow --help` prints help.
- [ ] **Step 5: Commit** `feat(cli): scaffold agentflow CLI package with output primitives`.

### Task 3: Config store and context resolution

**Files:**
- Create: `apps/cli/src/config-store.ts`, `apps/cli/src/context.ts`
- Test: `tests/unit/cli-config.test.ts`

**Interfaces:**
- Consumes: `CliIO`, `CliError`, `Output` (Task 2).
- Produces:
  - `config-store.ts`: `type StoredAuth = { type: "token"; token: string } | { type: "session"; sessionId: string; username: string; expiresAt: string }`; `type Profile = { url?: string; auth?: StoredAuth }`; `type Config = { currentProfile: string; profiles: Record<string, Profile> }` (zod `configSchema`, defaults `currentProfile: "default"`, `profiles: {}`); `configPath(io: CliIO): string` (`AGENTFLOW_CONFIG` > win32 `%APPDATA%\agentflow\config.json` > `$XDG_CONFIG_HOME/agentflow/config.json` > `<homedir>/.config/agentflow/config.json`); `class ConfigStore { constructor(path: string); load(): Promise<Config> /* missing file → defaults; invalid → CliError exit 1 naming path */; save(config: Config): Promise<void> /* mkdir 0o700, write <path>.<pid>.tmp mode 0o600, rename */; update(fn: (c: Config) => void): Promise<Config> }`; `maskSecrets(config: Config): Config` (token/sessionId → `"***"`).
  - `context.ts`: `interface GlobalFlags { profile?: string; url?: string; json: boolean; color: boolean; quiet: boolean; verbose: boolean }`; `interface Settings { profileName: string; baseUrl: string; auth?: StoredAuth; authSource: "env" | "profile" | "none" }`; `resolveSettings(config: Config, flags: GlobalFlags, env: CliIO["env"]): Settings` per spec §3 resolution order (`AGENTFLOW_TOKEN` → `{type:"token"}` with `authSource:"env"`); trailing `/` stripped from baseUrl; `interface CliContext { io: CliIO; out: Output; flags: GlobalFlags; store: ConfigStore; config: Config; settings: Settings }`; `createContext(io: CliIO, flags: GlobalFlags): Promise<CliContext>`. Task 4 adds a `client: ApiClient` field to `CliContext` and constructs it in `createContext`.

- [ ] **Step 1: Write failing tests** (temp dir per test via `mkdtemp`):
  - Missing file → `load()` returns `{ currentProfile: "default", profiles: {} }`.
  - Save then load round-trips; on non-win32, `stat(path).mode & 0o777 === 0o600`; no `*.tmp` files left in the dir.
  - File containing `{not json` → `load()` rejects with a `CliError` whose message contains the path and exitCode 1; file unchanged afterwards. Same for `{"profiles": 5}`.
  - `resolveSettings`: profile url used by default; `AGENTFLOW_URL` beats profile; `--url` beats env; `AGENTFLOW_PROFILE=prod` selects prod; `--profile dev` beats env; no url anywhere → `http://localhost:3000`; `AGENTFLOW_TOKEN` overrides profile session auth with `authSource: "env"`; `"http://x:3000/"` → `"http://x:3000"`.
  - `configPath`: win32 with `APPDATA=C:\A` → `C:\A\agentflow\config.json`; linux with `XDG_CONFIG_HOME=/x` → `/x/agentflow/config.json`; `AGENTFLOW_CONFIG` overrides both.
  - `maskSecrets` replaces token and sessionId with `"***"` and leaves `url`/`username`.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/cli-config.test.ts` — FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(cli): add profile config store and settings resolution`.

### Task 4: ApiClient, response schemas, error mapping

**Files:**
- Create: `apps/cli/src/api-client.ts`, `apps/cli/src/schemas.ts`
- Modify: `apps/cli/src/errors.ts` (add `ApiError`), `apps/cli/src/context.ts` (construct client)
- Test: `tests/unit/cli-api-client.test.ts`

**Interfaces:**
- Consumes: `Settings`, `StoredAuth`, `Output`, `CliIO`, `CliError`, `ExitCode`.
- Produces:
  - `errors.ts`: `class ApiError extends CliError { readonly status: number; readonly method: string; readonly path: string; readonly body: unknown }` and `apiError(status: number, body: unknown, ctx: { method: string; path: string; baseUrl: string; authType?: "token" | "session"; resource?: { kind: string; id: string }; requiredRole?: string }): ApiError` producing the exact messages and exit codes of spec §7 (400 `VALIDATION_ERROR` lists `details[].path.join(".")`: `message`).
  - `schemas.ts`: zod schemas with `.passthrough()` for `meSchema`, `runSummarySchema`, `runListSchema` (`{ runs, total, limit, offset }`), `runDetailSchema` (incl. `publicStatus`, `steps[]`), `historySchema` (`{ events: Array<{ id: string; sequence: number; stepId: string | null; attemptId: string | null; type: string; payload: unknown; createdAt: string }> }`, from `getRunHistory`), `attemptsSchema`, `approvalSchema` (fields from `getRunApprovals`), `approvalsSchema`, `toolExecutionsSchema`, `harnessOpsSchema`, `usageSchema`, `sourcesSchema`, `workflowSummarySchema`/`workflowListSchema`/`workflowDetailSchema` (Task 1 shapes), `workflowCreatedSchema`, `versionCreatedSchema`, `referenceSetupSchema` (`{ workflowId, workflowVersionId, workflowName, created, mode, provider, definition }`), `healthSchema`, `readySchema`, `loginSchema` (`{ user: { id, username, roles } }`). Export inferred types (`RunDetail`, `Approval`, etc.).
  - `api-client.ts`: `class ApiClient { constructor(opts: { baseUrl: string; auth?: StoredAuth; io: CliIO; out: Output }); request<T>(method: string, path: string, opts: { schema: ZodType<T>; body?: unknown; resource?: { kind: string; id: string }; requiredRole?: string; auth?: boolean }): Promise<T>; ` plus one method per endpoint: `health()`, `ready()`, `me()`, `login(username, password): Promise<{ user; sessionId: string; expiresAt: string }>` (reads `agentflow_session` from `headers.getSetCookie()`; expiry from `Max-Age`/`Expires`, else now+7d), `logout()`, `listWorkflows()`, `getWorkflow(id)`, `createWorkflow(body)`, `publishVersion(id, body)`, `setupReference(body)`, `listRuns({limit, offset})`, `getRun(id)`, `createRun(body)`, `runHistory(id)`, `runAttempts(id)`, `runApprovals(id)`, `runToolExecutions(id)`, `runHarnessOps(id)`, `runUsage(id)`, `runSources(id)`, `controlRun(id, "pause"|"resume"|"cancel")`, `listApprovals({ runId? })`, `decideApproval(id, body, requiredRole)`, `reconcile(id, body)` (requiredRole `"operator"`) }`.
  - Behaviour: token → `authorization: Bearer <t>`; session → `cookie: agentflow_session=<id>`; JSON bodies with `content-type`; network `TypeError` → `CliError` "Cannot reach AgentFlow API at <baseUrl> — is it running?" exit 1 (code `NETWORK`); 2xx body failing schema → `CliError` code `BAD_RESPONSE` exit 1 with spec message (issues in `details`, printed only with `-v`); verbose → `out.debug("→ GET /runs")` and `out.debug("← 200 GET /runs (12ms)")` with headers printed as `authorization: Bearer ***` / `cookie: agentflow_session=***`.

- [ ] **Step 1: Write failing tests** against `startFakeApi`:
  - Token auth sends `authorization: Bearer t0k3n`; session auth sends `cookie: agentflow_session=s1d`.
  - 401 with session auth → `ApiError` exitCode 3, message contains `agentflow login` and "expired"; 401 with token → exitCode 3 "Not logged in"; 403 with `requiredRole: "operator"` → message contains `operator`; 404 with `resource {kind:"Run", id:"abc12345"}` → `Run abc12345 not found (or not owned by you)`, exit 4; 409 `{error:"CONFLICT",message:"run already finished"}` → exit 5 and that message; 400 VALIDATION_ERROR with `details:[{path:["input"],message:"Required"}]` → exit 2, message contains `input: Required`; 500 → exit 1 `Server error (500)`.
  - Closed port → `CliError` code `NETWORK`, exit 1, message contains the base URL.
  - 200 with body `{ "unexpected": true }` for `getRun` → code `BAD_RESPONSE`, exit 1.
  - `login()` with fake `set-cookie: agentflow_session=abc; Max-Age=604800; Path=/; HttpOnly` → returns `sessionId: "abc"` and `expiresAt` = now+604800s.
  - Verbose mode with token auth: stderr contains `→ GET /me` and never contains the token string.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/cli-api-client.test.ts` — FAIL.
- [ ] **Step 3: Implement**; check exact history/attempt field names against `getRunHistory`/`getRunAttempts` in `packages/runtime/src/index.ts` and keep schemas `.passthrough()` so `--json` stays the raw body.
- [ ] **Step 4: Run** — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(cli): add typed API client with error-to-exit-code mapping`.

### Task 5: Prompts and auth/config/status commands

**Files:**
- Create: `apps/cli/src/prompt.ts`, `apps/cli/src/commands/auth.ts`, `commands/config.ts`, `commands/status.ts`
- Modify: `apps/cli/src/run.ts` (register)
- Test: `tests/unit/cli-prompt.test.ts`, `tests/unit/cli-commands-auth.test.ts`

**Interfaces:**
- Consumes: `CliContext`, `ApiClient`, `ConfigStore`, `maskSecrets`, `Output`.
- Produces:
  - `prompt.ts`: `ask(io, question): Promise<string>`; `askSecret(io, question): Promise<string>` (raw mode, echoes nothing, handles backspace/Enter/Ctrl-C → `CliError` exit 130); `confirm(io, question, opts: { yes: boolean }): Promise<boolean>` (`yes` → true without prompting; `!io.stdin.isTTY` → throws `UsageError("Refusing to <question> without --yes in a non-interactive session")`); `readStdin(io): Promise<string>`. Prompts write to stderr.
  - `registerAuthCommands(program, getContext)`, `registerConfigCommands(...)`, `registerStatusCommand(...)` — commands from spec §2/§3. `login`: TTY required unless `--token` with piped stdin; non-TTY without `--token` → UsageError. Saves profile `url` = resolved base URL. `login --token` verifies via `me()` before saving. `logout`: best-effort `client.logout()` for session auth, always removes `auth`; prints `Logged out of profile <name>`. `whoami` human output: `id`, `username` (if any), `roles` (comma list or `(none)`), `profile`, `url`, `auth` (`token`/`session (expires in 6d)`/`env token`). `config set` allows only key `url`; other keys → UsageError. `status`: `GET /health` then `/ready`; prints `api ok`, `database ok`, `queue ok`; `/ready` failure → exit 1 with `api ok` / `ready: <error>`.

- [ ] **Step 1: Write failing tests**:
  - `askSecret` with a TTY-flagged PassThrough stdin fed `"pa\u007fss\r"` resolves `"pss"`, and stderr does not contain `pss`.
  - `confirm` with non-TTY stdin and `yes:false` throws `UsageError` (exit 2); with `yes:true` returns true without reading.
  - `login --token` with piped stdin `"t0k3n\n"` against fake API whose `/me` returns `{id:"u1",roles:["operator"]}` → exit 0; config file has `profiles.default.auth = {type:"token",token:"t0k3n"}` and `url` = fake URL; stdout/stderr never contain `t0k3n`.
  - `login --token` when `/me` returns 401 → exit 3, config file not written.
  - `login` with non-TTY stdin and no `--token` → exit 2, no HTTP requests made.
  - `login --username admin` with TTY stdin fed `"pw\r"`, fake `/auth/login` returning set-cookie → config stores `{type:"session", sessionId, username:"admin"}`.
  - `logout` on session profile → fake API saw `POST /auth/logout` with cookie; profile has no `auth`. When the API is unreachable, logout still clears auth and exits 0 with a warning on stderr.
  - `whoami --json` prints the `/me` body exactly; `config list` output contains `***` and not the token; `config set url http://x` persists; `config set token x` → exit 2; `config use prod` sets `currentProfile`.
  - `status` with healthy fake → exit 0, stdout has `database ok`; with `/ready` 500 → exit 1.
- [ ] **Step 2: Run** both test files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(cli): add login/logout/whoami, config and status commands`.

### Task 6: Workflow commands

**Files:**
- Create: `apps/cli/src/commands/workflows.ts`, `apps/cli/src/input.ts`
- Modify: `apps/cli/src/run.ts`
- Test: `tests/unit/cli-commands-workflows.test.ts`

**Interfaces:**
- Consumes: `ApiClient` workflow methods, `Output`, `parseDuration`, `readStdin`, `@agentflow/shared` `createWorkflowSchema`, `createWorkflowVersionSchema`.
- Produces:
  - `input.ts`: `readJsonSource(io: CliIO, source: string): Promise<unknown>` (`-` → stdin, else file; invalid JSON → UsageError naming the source); `applySets(base: Record<string, unknown>, sets: string[]): Record<string, unknown>` (`k=v`, value `JSON.parse`d if valid else string; missing `=` → UsageError). Reused by Tasks 7 and 9.
  - `registerWorkflowCommands(program, getContext)`: `list` (table: ID (first 8), NAME, LATEST, VERSIONS, CREATED relative; `-q` → full IDs), `show <id>` (key/value block + versions table: VERSION, ID, STEPS, CREATED), `create` (validates with `createWorkflowSchema`; prints `Created workflow <name> (<id>)`; `-q` → id), `publish <id> --version <n> [--definition <file|->]` (body validated with `createWorkflowVersionSchema` — omitting `--definition` uses the shared default; prints `Published version <n> of workflow <workflowId> (<versionId>)`; `-q` → versionId), `reference [--mode] [--provider] [--model] [--reviewer-role] [--approval-expires <dur>]` (maps to `approvalExpiresAfterMs`; prints `Reference workflow <name> v<version> ready (<versionId>)` + `created`/`already existed`; `-q` → versionId).

- [ ] **Step 1: Write failing tests**: `workflows list` renders names and `(none)` for null latestVersion; `-q` prints only ids; `--json` equals the fake body. `create --name ""` → exit 2 with no request sent. `publish <id> --version 1 --definition def.json` sends `{version:1, definition:<file contents>}`; `--definition -` reads stdin; malformed file → exit 2 mentioning the file name. `reference --approval-expires 2h` sends `approvalExpiresAfterMs: 7200000` and `mode:"scripted"` default; `reference --mode live` with the fake returning 400 `VALIDATION_ERROR` → exit 2 (the setup schema lives in `@agentflow/research`, which the CLI must not import, so validation stays server-side). `show <unknown>` → exit 4.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(cli): add workflow commands`.

### Task 7: Run commands (list/start/show/sub-resources/control) and short IDs

**Files:**
- Create: `apps/cli/src/commands/runs.ts`, `apps/cli/src/resolve-id.ts`, `apps/cli/src/render/run.ts`
- Modify: `apps/cli/src/run.ts`
- Test: `tests/unit/cli-commands-runs.test.ts`

**Interfaces:**
- Consumes: `ApiClient` run methods, `readJsonSource`, `applySets`, `parseDuration`, `confirm`, `paintStatus`, `renderTable`, `createRunSchema`.
- Produces:
  - `resolve-id.ts`: `resolveRunId(client: ApiClient, raw: string): Promise<string>` — full UUID returned as-is (no request); lowercase hex/dash prefix of length ≥ 8 → page `listRuns({limit:100, offset})` until `offset >= total`, collect `id.startsWith(prefix)`; 0 → `CliError` exit 4 `Run <raw> not found (or not owned by you)`; >1 → `UsageError` listing up to 5 matches; length < 8 or non-hex → `UsageError("Run ID must be a full UUID or a prefix of at least 8 characters")`.
  - `render/run.ts`: `renderRunDetail(run: RunDetail, opts: { color: boolean; now: number; width: number; verbose: boolean }): string` (header: id, status painted, workflow version id, created/finished relative, deadline, failure summary; then steps table: `#`, KEY, KIND, STATUS, ATTEMPTS `n/max`, UPDATED). Reused by Task 8.
  - `registerRunCommands(program, getContext)`: `list` (`--status` filters `publicStatus` case-insensitively after fetch; table ID(8), WORKFLOW `name@v`, STATUS, STEPS `done/total`, TOKENS `in/out`, CREATED), `start <workflowVersionId> [--input] [--set ...] [--creation-key] [--deadline] [--watch]` (body validated with `createRunSchema`; prints `Started run <id> (<status>)`; `-q` → id; the `--watch` flag is added in Task 8), `show`, `history|attempts|usage|sources|tools|ops` (tables of the most useful fields; `--json` raw), `pause|resume` (prints `Run <id>: <publicStatus>`), `cancel [--yes]` (requires `confirm`).

- [ ] **Step 1: Write failing tests**:
  - `resolveRunId`: full UUID → no request; prefix matching one run on page 2 (total 150) → resolves after 2 list calls; two matches → exit 2 listing both; zero → exit 4; `"abc"` → exit 2.
  - `runs start <v> --input in.json --set region=\"eu\" --set retries=3 --deadline 90s` sends `input` = file merged with `{region:"eu", retries:3}` and `deadlineMs: 90000`; `--deadline 500ms` → exit 2 with no request (below `createRunSchema` min 1000).
  - `runs list --status waiting_approval` keeps only matching runs; `-q` prints only ids.
  - `runs show <prefix>` renders step keys and `2/3` attempts column; `--json` equals fake body.
  - `runs cancel <id>` with non-TTY stdin → exit 2 and no POST; with `--yes` → POST `/runs/<id>/cancel`.
  - `runs pause <id>` on 409 → exit 5.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(cli): add run commands with short-ID resolution`.

### Task 8: `runs watch` and `runs start --watch`

**Files:**
- Create: `apps/cli/src/watch.ts`
- Modify: `apps/cli/src/commands/runs.ts` (add `watch` subcommand and `start --watch`)
- Test: `tests/unit/cli-watch.test.ts`

**Interfaces:**
- Consumes: `ApiClient.getRun`, `ApiClient.runHistory`, `renderRunDetail`, `ExitCode`, `parseDuration`, `CliIO.sleep/now/signal`.
- Produces: `watchRun(ctx: CliContext, runId: string, opts: { intervalMs: number; timeoutMs?: number; untilTerminal: boolean }): Promise<number>` returning an exit code. Stop rules and code mapping exactly as spec §2 "watch keys off publicStatus". TTY: after first draw, each tick writes `\x1b[<n>A\x1b[0J` (n = lines previously drawn) then the new `renderRunDetail`. Non-TTY: print one line per history event not yet seen (by event id) as `<ISO time>  <event type>  <step key if any>`, then on stop a final line `Run <id> <publicStatus>`. Transient errors (`CliError` code `NETWORK`, or `ApiError` status ≥ 500): `out.warn("Retrying in <n>s: <message>")`, after the n-th consecutive failure sleep `min(interval * 2^n, 30000)` instead of `interval`, reset n to 0 after a success; other errors rethrow. Abort signal → stderr `Stopped watching; run <id> is unaffected`, return 130. `--json`: no live output; print final `GET /runs/:id` body once on stop.

- [ ] **Step 1: Write failing tests** using a fake API that serves a scripted sequence of `publicStatus` per `GET /runs/:id` call and instant `sleep`:
  - `QUEUED → RUNNING → SUCCEEDED` → exit 0; non-TTY stdout has a final line ending `SUCCEEDED`.
  - `RUNNING → WAITING_APPROVAL` → exit 12; same with `--until-terminal` then `→ SUCCEEDED` → exit 0.
  - `NEEDS_ATTENTION` → 12; `FAILED` → 10; `CANCELLED` → 11; `TIMED_OUT` → 14; `PAUSED` then `RUNNING` then `SUCCEEDED` → keeps watching, exit 0.
  - Sequence `500, 500, RUNNING, SUCCEEDED` → exit 0, stderr contains `Retrying`, recorded sleep durations exactly `[4000, 8000, 2000]` given interval 2s (backoff, backoff, reset); backoff never exceeds 30000 with 10 consecutive 500s.
  - 404 mid-watch → exit 4 immediately.
  - `--timeout 5s` with fake `now` advancing 2s per sleep and status stuck `RUNNING` → exit 13.
  - Aborting the signal after the first tick → exit 130 and stderr contains `run <id> is unaffected`.
  - TTY stdout: second frame output contains `\x1b[` cursor-up sequence; non-TTY output contains no `\x1b[`.
  - History events deduplicated across ticks (event printed once even when returned on 3 polls).
  - `runs start <v> --watch` posts the run then watches it (exit code from watch); `--json` prints only the final run body.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(cli): add live run watching with exit codes`.

### Task 9: Approvals and tool reconciliation commands

**Files:**
- Create: `apps/cli/src/commands/approvals.ts`, `apps/cli/src/commands/tools.ts`
- Modify: `apps/cli/src/run.ts`
- Test: `tests/unit/cli-commands-approvals.test.ts`

**Interfaces:**
- Consumes: `ApiClient.listApprovals/decideApproval/reconcile`, `confirm`, `readJsonSource`, `resolveRunId`, `@agentflow/shared` `canonicalJson`, `approvalDecisionSchema`, `reconciliationDecisionSchema`; `randomUUID` from `node:crypto`.
- Produces:
  - `findPendingApproval(client, id: string): Promise<Approval>` — searches `listApprovals({})`; absent → `CliError` exit 4 `Approval <id> not found, not pending, or not assigned to your roles`.
  - `verifyApprovalHashes(approval: Approval): void` — `sha256hex(canonicalJson(approval.proposal)) === approval.proposalHash` and same for payload; mismatch → `CliError` exit 1 code `HASH_MISMATCH`, message `Approval <id> content does not match its hashes; refusing to sign`.
  - `registerApprovalCommands`: `list [--run <id>]` (run id via `resolveRunId`; table ID(8), RUN(8), STEP (`proposal.stepKey`), ROLE, EXPIRES relative, CREATED), `show <id>` (proposal and payload pretty JSON + hashes), `approve|reject <id> [--yes]` (find → verify → render to stderr → `confirm` → body `{ decisionRequestId: randomUUID(), decision, proposalHash, payloadHash }` validated with `approvalDecisionSchema` → `decideApproval(id, body, approval.reviewerRole)` → `Approved approval <id>` / `Rejected approval <id>`).
  - `registerToolCommands`: `tools reconcile <id> (--succeeded --receiver <id> --receipt <file|-> | --fail) [--yes]` — exactly one of `--succeeded`/`--fail` else UsageError; body validated with `reconciliationDecisionSchema` (`CONFIRM_SUCCEEDED` / `FAIL_FINAL`); `confirm`; prints `Tool execution <id> reconciled: <resolution>`.

- [ ] **Step 1: Write failing tests** (build fake approvals whose hashes are computed with `canonicalJson` + sha256 in the test):
  - `approvals approve <id> --yes` posts `decision: "APPROVE"` with the fake's `proposalHash`/`payloadHash` and a UUID `decisionRequestId`; two invocations use different `decisionRequestId`s.
  - Tampered fake (payload changed, hash kept) → exit 1, stderr contains `refusing to sign`, no POST made.
  - `approve` without `--yes` on non-TTY → exit 2, no POST.
  - Approval missing from list → exit 4; server 403 → exit 3 and message names the `reviewerRole`.
  - `approvals list --run <prefix>` sends `GET /approvals?runId=<full uuid>`.
  - `tools reconcile <id> --fail --yes` posts `{resolution:"FAIL_FINAL"}`; `--succeeded --receiver r1 --receipt receipt.json --yes` posts `CONFIRM_SUCCEEDED` with receipt object; `--succeeded` without `--receipt` → exit 2 no request; both flags → exit 2; 403 → exit 3 message mentions `operator`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; full unit suite `pnpm exec vitest run tests/unit` PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(cli): add approval and tool reconciliation commands`.

### Task 10: End-to-end integration test and documentation

**Files:**
- Create: `tests/integration/cli.test.ts`
- Modify: `README.md` (new "CLI" section; add to table of contents if present), `CLAUDE.md` (Commands: `pnpm agentflow ...`; Architecture: `apps/cli` bullet)

**Interfaces:**
- Consumes: `run(argv, io)` from `apps/cli/src/run.ts`, `fakeIO` from `tests/unit/cli-helpers.ts`; API/worker/outbox setup pattern from `tests/integration/durable-path.test.ts` (own queue name `agentflow-cli-test-operations`, `createOperationWorker` with `ScriptedResearchProvider`, `createOutboxDispatcher`).

- [ ] **Step 1: Write the integration test.** Credentials: `cli-e2e-<uuid>` with token `cli-e2e-token`, roles `["release-manager","research-reviewer","operator"]`. Each CLI call uses `fakeIO` with `env.AGENTFLOW_CONFIG` pointing into a temp dir and real `fetch`. Flow:
  1. `login --token --url <baseUrl>` (stdin `cli-e2e-token`) → 0; `whoami --json` → `id` matches.
  2. `workflows create --name cli-e2e-<uuid> -q` → id; `workflows publish <id> --version 1 --definition <tmp file with approval-then-finalize definition, reviewerRole release-manager>` → 0; `workflows show <id> --json` → one version.
  3. `runs start <versionId> --set release=\"r1\" -q` → run id; `runs watch <first 8 chars> --interval 100ms` → exit 12.
  4. `approvals list --json` contains the run's approval; `approvals approve <approvalId> --yes` → 0.
  5. `runs watch <runId> --interval 100ms --timeout 20s` → exit 0; `runs show <runId> --json` → `publicStatus: "SUCCEEDED"`.
  6. `runs cancel <runId> --yes` → exit 5 (already finished) — confirms conflict mapping end-to-end.
  7. `logout` → 0; `whoami` → exit 3 (no auth stored, no env token).
- [ ] **Step 2: Run** `pnpm exec vitest run tests/integration/cli.test.ts` — PASS (all code exists; if it fails, the failure is a real defect: fix in the owning module and add a unit test there).
- [ ] **Step 3: Write docs.** README "CLI" section: install (`pnpm install`, `pnpm agentflow --help`, `pnpm --filter @agentflow/cli link --global`), login (password and `--token`, `AGENTFLOW_URL`/`AGENTFLOW_TOKEN`/`AGENTFLOW_PROFILE`/`AGENTFLOW_CONFIG`), a walkthrough mirroring the integration flow, `--json` + `jq` example, exit-code table copied from the spec. CLAUDE.md: one Commands line and one Packages/apps bullet. Do not touch `evaluation-results/` or evidence claims.
- [ ] **Step 4: Verify** `pnpm typecheck` clean; `pnpm test` PASS (with Postgres + Redis up); manually against `pnpm dev:api` + `pnpm dev:worker`: `pnpm agentflow status`, `pnpm agentflow login --token`, `pnpm agentflow workflows reference`, `pnpm agentflow runs start <versionId> --watch` reaches exit 12.
- [ ] **Step 5: Commit** `test(cli): add end-to-end CLI integration test and document CLI usage`.
