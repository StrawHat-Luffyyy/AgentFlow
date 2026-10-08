# AgentFlow CLI — Design

Date: 2026-10-08
Status: Approved in conversation; pending written-spec review

## 1. Goal

Make AgentFlow fully usable from a terminal through a professional `agentflow` CLI that offers
parity with the web dashboard plus terminal-native capabilities (scriptable `--json` output,
meaningful exit codes, live `watch` of runs, CI-friendly auth via env vars).

### Decisions

| Topic | Decision |
|---|---|
| Role | **Pure API client.** Talks HTTP to a running AgentFlow API (local or remote). Never touches Postgres directly; all ownership and role checks stay server-side. Local dev/ops commands (`db migrate`, `dev up`, eval) are out of scope but may be added later as a separate command group. |
| Distribution | **Workspace-first, bundle-ready.** New `apps/cli` package runs via `tsx` like the rest of the monorepo. Runtime imports are limited to `commander`, `zod`, and `@agentflow/shared` so a later tsup/esbuild bundle for `npm i -g` is a build-step addition only. |
| Auth | **Both bearer tokens and username/password sessions, with named profiles.** Plaintext config file with 0600 perms; env vars override for CI. No OS keychain. |
| Server changes | **Add three read-only endpoints**: `GET /workflows`, `GET /workflows/:id`, `GET /approvals`. `watch` polls; no SSE. |
| Framework | **Commander** + Node built-ins (`node:util` `styleText`, `node:readline`, global `fetch`). |

### Non-goals (YAGNI)

Standalone bundle / npm publish (structure allows it later), shell completion, SSE/streaming,
local dev/ops commands, keychain storage, full-screen TUI.

## 2. Command tree

Global flags (all commands): `--profile <name>`, `--url <base>`, `--json`, `--no-color`,
`-q/--quiet`, `-v/--verbose` (request log lines to stderr).

```
agentflow login [--token] [--username <u>]
agentflow logout
agentflow whoami                                       # GET /me
agentflow config list | get <key> | set <key> <value> | use <profile>

agentflow status                                       # GET /health + GET /ready

agentflow workflows list                               # NEW GET /workflows
agentflow workflows show <id>                          # NEW GET /workflows/:id (with versions)
agentflow workflows create --name <n> [--description <d>]           # POST /workflows
agentflow workflows publish <id> --version <n> [--definition <file|->]  # POST /workflows/:id/versions
agentflow workflows reference [--mode scripted|live] [--provider <p> --model <m>]
                              [--reviewer-role <r>] [--approval-expires <dur>]
                                                       # POST /reference-workflows/cloud-comparison

agentflow runs list [--limit 50] [--offset 0] [--status <s>]        # GET /runs; --status filters client-side
agentflow runs start <workflowVersionId> [--input <file|->] [--set k=v ...]
                     [--creation-key <k>] [--deadline <dur>] [--watch]   # POST /runs
agentflow runs show <id>                               # GET /runs/:id
agentflow runs watch <id> [--interval 2s] [--timeout <dur>] [--until-terminal]
agentflow runs history <id>                            # GET /runs/:id/history
agentflow runs attempts <id>                           # GET /runs/:id/attempts
agentflow runs usage <id>                              # GET /runs/:id/usage
agentflow runs sources <id>                            # GET /runs/:id/sources
agentflow runs tools <id>                              # GET /runs/:id/tool-executions
agentflow runs ops <id>                                # GET /runs/:id/harness-operations
agentflow runs pause | resume <id>                     # POST /runs/:id/{pause,resume}
agentflow runs cancel <id> [--yes]                     # POST /runs/:id/cancel

agentflow approvals list [--run <id>]                  # NEW GET /approvals (pending, role-filtered)
agentflow approvals show <id>
agentflow approvals approve <id> [--yes]               # POST /approvals/:id/decisions
agentflow approvals reject <id> [--yes]

agentflow tools reconcile <toolExecutionId> --succeeded --receiver <id> --receipt <file|-> [--yes]
agentflow tools reconcile <toolExecutionId> --fail [--yes]
                                                       # POST /tool-executions/:id/reconcile
```

### Command semantics

- **`runs start` input**: `--input` reads a JSON object from a file or `-` (stdin); `--set k=v`
  sets top-level keys (value parsed as JSON if it parses, else string) and is applied on top of
  `--input`. Body is validated client-side with `createRunSchema` before sending.
  `--deadline` accepts durations (`90s`, `5m`, `1h`) converted to `deadlineMs`.
- **`runs start --watch`** behaves as `runs start` followed by `runs watch <newId>`.
- **`runs watch`** exits when the run reaches a terminal state, or when it reaches `WAITING`
  unless `--until-terminal` is set.
- **Short run IDs**: any `runs <verb> <id>` accepts a full UUID or a unique prefix of ≥ 8 hex
  characters, resolved by paging `GET /runs`. Ambiguous prefix → usage error listing matches;
  no match → not-found error.
- **`approvals approve|reject`**: fetches the approval, renders proposal and payload together
  with the `proposalHash`/`payloadHash` that will be submitted, asks for confirmation (unless
  `--yes`), generates a fresh UUID `decisionRequestId`, validates the body with
  `approvalDecisionSchema`, and POSTs. The hashes sent are exactly those of the content shown,
  so a reviewer cannot approve content they did not see.
- **`tools reconcile`**: `--succeeded` requires `--receiver` and `--receipt` (JSON object from
  file or stdin) and maps to `CONFIRM_SUCCEEDED`; `--fail` maps to `FAIL_FINAL`. Validated with
  `reconciliationDecisionSchema`. Exactly one of `--succeeded`/`--fail` is required.
- **Confirmation**: `runs cancel`, `approvals reject`, `approvals approve`, and
  `tools reconcile` prompt for confirmation unless `--yes`. When stdin is not a TTY they refuse
  (usage error, exit 2) without `--yes`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (for `watch`: run `SUCCEEDED`) |
| 1 | Generic / network / unexpected-response error |
| 2 | Usage or validation error (bad flags, client-side zod failure, HTTP 400) |
| 3 | Authentication / authorization error (HTTP 401, 403) |
| 4 | Not found (HTTP 404, unresolved short ID) |
| 5 | Conflict (HTTP 409) |
| 10 | `watch`: run finished `FAILED` |
| 11 | `watch`: run finished `CANCELLED` |
| 12 | `watch`: run reached `WAITING` (approval or reconciliation) without `--until-terminal` |
| 13 | `watch`: `--timeout` elapsed before a stopping state |
| 14 | `watch`: run finished `TIMED_OUT` (run deadline exceeded) |
| 130 | Interrupted (Ctrl-C) |

`watch` keys off `publicStatus` from `GET /runs/:id` (`derivePublicStatus` in
`packages/runtime`): terminal values `SUCCEEDED`/`FAILED`/`CANCELLED`/`TIMED_OUT` map to
0/10/11/14; `WAITING_APPROVAL` and `NEEDS_ATTENTION` (reconciliation) are the "waiting" stop
states (exit 12 unless `--until-terminal`). `QUEUED`, `RUNNING`, `RETRY_WAIT`,
`PAUSE_REQUESTED`, `PAUSED`, and `CANCEL_REQUESTED` keep watching.

## 3. Authentication and configuration

### Config file

- Path: `$XDG_CONFIG_HOME/agentflow/config.json`, else `~/.config/agentflow/config.json` on
  POSIX; `%APPDATA%\agentflow\config.json` on Windows. Overridable with `AGENTFLOW_CONFIG`.
- Shape:
  ```json
  {
    "currentProfile": "default",
    "profiles": {
      "default": { "url": "http://localhost:3000", "auth": { "type": "token", "token": "..." } },
      "prod":    { "url": "https://agentflow.example", "auth": { "type": "session", "sessionId": "...", "username": "alice", "expiresAt": "..." } }
    }
  }
  ```
- Written atomically (write temp file in same dir, then rename) with mode 0600 on POSIX
  (directory 0700). On Windows, rely on the per-user `%APPDATA%` ACL.
- Parsed with a zod schema; a corrupt file produces a clear error naming the path rather than
  being silently overwritten.

### Resolution order

For each of base URL and credential: **flag > env > selected profile > default**.

- Profile selection: `--profile` > `AGENTFLOW_PROFILE` > `currentProfile` > `"default"`.
- URL: `--url` > `AGENTFLOW_URL` > profile `url` > `http://localhost:3000`.
- Credential: `AGENTFLOW_TOKEN` (bearer) > profile `auth`. No flag for secrets.

### Commands

- **`login`** (default): prompts for username (or `--username`) and password (masked input),
  POSTs `/auth/login`, extracts `agentflow_session` from `Set-Cookie`, stores
  `{type:"session", sessionId, username, expiresAt}` in the selected profile, along with the
  resolved URL. Prints the logged-in identity.
- **`login --token`**: reads the token from stdin when piped, otherwise prompts with masked
  input. Verifies it via `GET /me` before saving `{type:"token", token}`.
- **`logout`**: for session auth, POSTs `/auth/logout` with the cookie (best effort); then
  removes the `auth` entry from the profile in all cases.
- **`whoami`**: `GET /me`; prints id, username (if any), roles, profile, URL, auth type.
- **`config`**: `list` (secrets masked as `***`), `get <key>`, `set <key> <value>` for
  non-secret keys (`url`), `use <profile>` sets `currentProfile` (creating the profile if absent).

### Transport

- Token auth → `Authorization: Bearer <token>`.
- Session auth → `Cookie: agentflow_session=<id>`.
- A 401 on a session profile yields the message "Session expired — run `agentflow login`".

## 4. Server-side additions

All new domain logic goes in `packages/runtime/src/index.ts` (per repo convention); route
handlers in `apps/api/src/app.ts` stay thin. All three endpoints are read-only and sit behind
`authenticationMiddleware`.

1. **`listWorkflows(db, { ownerId })`** → `GET /workflows`
   Returns `{ workflows: [{ id, name, description, createdAt, latestVersion, versionCount }] }`
   for workflows owned by the caller, newest first.
2. **`getWorkflow(db, workflowId)`** → `GET /workflows/:id`
   Returns `{ id, name, description, createdAt, versions: [{ id, version, createdAt, stepCount }] }`.
   Ownership is enforced by the existing ownership middleware (its regex already matches
   `/workflows/:id`); unknown or foreign IDs → 404.
3. **`listPendingApprovals(db, { ownerId, roles, runId? })`** → `GET /approvals?runId=<uuid>`
   Returns `{ approvals: [...] }` with pending, unexpired approvals on runs owned by the caller
   whose `reviewer_role` is one of the caller's roles. Each item has the same fields as
   `GET /runs/:id/approvals` items plus `runId`. Query params validated with zod (`runId`
   optional UUID).

"Pending" means `approvals.status = 'PENDING' AND approvals.expires_at > now()` (table from
migration 0003). Ownership joins `approvals → workflow_runs → workflow_versions → workflows`
on `owner_id`, the same path the API ownership middleware uses. No migration is needed.

## 5. Package architecture

```
apps/cli/
  package.json        # @agentflow/cli; bin: { "agentflow": "./bin/agentflow.js" }
                      # deps: commander, zod, @agentflow/shared (workspace:*)
                      # scripts: typecheck, build (= typecheck), start
  tsconfig.json       # extends repo base, same strictness flags
  bin/agentflow.js    # #!/usr/bin/env node — registers tsx and imports ../src/main.ts
  src/
    main.ts           # builds the Commander program, global flags, top-level error → exit code
    run.ts            # export run(argv, io) — testable entry; io = { stdout, stderr, stdin, env, isTTY }
    context.ts        # resolves profile/env/flags → { baseUrl, credential, output options }
    config-store.ts   # load/save config.json (zod-validated, atomic, 0600, per-OS path)
    api-client.ts     # ApiClient: one typed method per endpoint; ApiError(status, code, body)
    schemas.ts        # zod response schemas used by ApiClient
    resolve-id.ts     # short run-ID prefix resolution
    prompt.ts         # ask, askSecret (masked), confirm — throws usage error when !isTTY
    watch.ts          # polling loop, change detection, redraw/append rendering, stop logic
    output/
      emit.ts         # emit(data, { json, render }) — JSON vs human dispatch
      table.ts        # column layout, terminal-width truncation
      style.ts        # styleText wrappers, status→color map, color enablement
      duration.ts     # parse "90s|5m|1h" ⇄ ms; relative time formatting
    commands/
      auth.ts  config.ts  status.ts  workflows.ts  runs.ts  approvals.ts  tools.ts
```

Boundaries:

- **`ApiClient`** is the only module that performs HTTP. It owns auth headers, JSON encoding,
  response parsing with `schemas.ts`, verbose request logging (with secrets masked), and
  mapping non-2xx responses to `ApiError`.
- **Commands** orchestrate: parse options → (validate request with `@agentflow/shared` schemas)
  → call `ApiClient` → `emit`. They contain no HTTP or rendering primitives.
- **Response schemas live in the CLI**, not `shared` (mirrors how `apps/web/src/api.ts` keeps
  its own types; consolidating is a separate refactor). Request bodies reuse `shared` schemas.
- **`run(argv, io)`** never calls `process.exit`; it returns the exit code. Only `main.ts`
  touches `process`.

Root `package.json` gains `"agentflow": "pnpm --filter @agentflow/cli exec agentflow"` so
`pnpm agentflow <cmd>` works without linking; `pnpm --filter @agentflow/cli link --global`
provides a global `agentflow`.

## 6. Output contract

- **stdout = data only.** Prompts, progress, warnings, and verbose logs go to stderr.
- **`--json`**: prints the API response body (one JSON document) — pretty on TTY, compact
  otherwise. This is the stable scripting contract and tracks the API shape, not the human
  rendering. For `runs start --watch --json`, the final `GET /runs/:id` body is printed.
- **Human mode**: tables for lists; key/value block plus step table for `show`; statuses
  coloured (`SUCCEEDED` green; `FAILED`/`TIMED_OUT` red; `WAITING_APPROVAL`/`NEEDS_ATTENTION`/
  `PAUSED`/`RETRY_WAIT` yellow; `RUNNING`/`QUEUED` cyan; `CANCELLED` dim); relative
  times ("3m ago"), absolute ISO times with `-v`; long JSON fields truncated in tables, shown in
  full in `show`.
- **`-q/--quiet`**: lists print IDs only, one per line; mutating commands print only the
  affected ID.
- **Colour** is disabled by `--no-color`, `NO_COLOR`, `TERM=dumb`, or non-TTY stdout.

### `watch`

- Polls `GET /runs/:id` and `GET /runs/:id/history` every `--interval` (default 2s).
- TTY: redraws the status header and step table in place (cursor-up + clear-line; no alternate
  screen). Non-TTY: appends one line per new history event and a final status line.
- Transient failures (network errors, 5xx) back off exponentially up to 30s and are reported
  on stderr; 401/403/404 abort immediately with the normal error mapping.
- Ctrl-C stops watching, prints "Stopped watching; run <id> is unaffected", exits 130.

## 7. Error handling

`ApiError` and client-side failures are mapped once, in `run.ts`:

| Condition | stderr message | Exit |
|---|---|---|
| 400 `VALIDATION_ERROR` / client-side zod failure | each issue as `path: message` | 2 |
| 400 other / 413 | server `error` + `message` | 2 |
| 401 | "Not logged in or session expired — run `agentflow login`" | 3 |
| 403 | "Forbidden — this action requires role `<role>`" when known (approval reviewer role, `operator` for reconcile), else "Forbidden" | 3 |
| 404 | "`<Kind>` `<id>` not found (or not owned by you)" | 4 |
| 409 | server conflict message | 5 |
| Network failure | "Cannot reach AgentFlow API at `<url>` — is it running?" | 1 |
| Response fails schema | "Unexpected response from `<method> <path>` — CLI and API versions may differ" (+ issues with `-v`) | 1 |
| 5xx | "Server error (`<status>`)" + server `error` code if present | 1 |

With `--json`, errors are additionally written to stderr as
`{"error":{"code":"...","message":"...","status":<n>,"details":...}}`.

Secrets (bearer tokens, session IDs, passwords) never appear in output, verbose logs, or error
messages.

## 8. Testing

All under the existing root `tests/` tree, Vitest, no new config.

- **`tests/unit/cli-config.test.ts`** — resolution order (flag > env > profile > default),
  profile selection, atomic save, 0600 mode (POSIX only), corrupt-file error, secret masking
  in `config list`.
- **`tests/unit/cli-output.test.ts`** — duration parse/format, table layout at fixed widths,
  colour enablement rules, `--quiet` behaviour.
- **`tests/unit/cli-commands.test.ts`** — each command run via `run(argv, io)` against an
  in-process `node:http` fake server: asserts method, path, headers (auth), request body, stdout,
  stderr, and exit code. Covers error→exit-code mapping, short-ID resolution (unique /
  ambiguous / none), confirmation refusal without TTY, approval hash pass-through, `watch` stop
  conditions with a scripted sequence of run states.
- **`tests/integration/cli.test.ts`** — real Postgres + Redis via the existing integration
  setup; `createApp` on an ephemeral port with test credentials. End-to-end:
  `login --token` → `workflows reference` → `runs start` → drive the worker inline as existing
  integration tests do → `runs watch` stops at `WAITING` (exit 12) → `approvals list` →
  `approvals approve --yes` → `runs watch` → exit 0. Plus new-endpoint coverage: owner scoping
  (other principal sees empty list / 404) and role filtering on `GET /approvals`.

## 9. Documentation

- README: new "CLI" section — install/link, login (token and password), profiles, common
  workflows, `--json` scripting examples, exit-code table.
- CLAUDE.md: add `pnpm agentflow` to Commands and `apps/cli` to the architecture notes.
- No changes to `evaluation-results/` or evidence claims.
