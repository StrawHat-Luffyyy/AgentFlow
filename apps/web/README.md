# AgentFlow web

Minimal React/Vite operations console for AgentFlow. It provides a run list, step and attempt
inspection, committed JSON output views, durable history and usage summaries, run controls, and
approval decisions. It intentionally does not include a visual workflow editor.

Run the API, worker, and dashboard from the repository root:

```powershell
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

Vite serves the console at `http://localhost:4173` and proxies `/api` to
`http://localhost:3000`. Use `VITE_API_BASE_URL` to override the API base URL.
