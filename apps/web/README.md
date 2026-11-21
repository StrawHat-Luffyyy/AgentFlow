# AgentFlow web

React 19 / Vite operations console for AgentFlow. Pages: Runs (filters kept in the URL), Run
detail (recovery events, step timeline, token panel, step inspector, run controls, in-place
approval, Reconcile for `UNKNOWN` side effects), Approvals, Usage (billed vs avoided tokens per
day), Workflows (immutable versions and their steps) and Settings. `Ctrl/Cmd+K` opens the command
palette. It intentionally does not include a visual workflow editor.

Layout: `design/` holds the tokens and Radix-based components, `shell/` the app frame and command
palette, `pages/` one file per page, `components/` pieces shared between pages, and `lib/` pure
helpers (unit-tested in `tests/unit/web-console.test.ts`). `api.ts` is the only HTTP code.

Run the API, worker, and console from the repository root:

```powershell
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

Vite serves the console at `http://localhost:4173` and proxies `/api` to
`http://127.0.0.1:3000`. `AGENTFLOW_WEB_PORT` and `AGENTFLOW_API_PROXY_TARGET` override those
(the Playwright tests use them); `VITE_API_BASE_URL` overrides the API base URL in the browser.

Smoke tests and README screenshots run against their own isolated stack:

```powershell
pnpm test:e2e
pnpm screenshots
```
