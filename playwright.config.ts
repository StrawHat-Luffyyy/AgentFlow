import { defineConfig } from "@playwright/test";
import { E2E_API_PORT, E2E_BASE_URL, E2E_WEB_PORT, adminPassword } from "./tests/e2e/env.ts";

adminPassword(); // Fix the password in this process so the servers and test workers inherit it.

/** Console smoke tests against an isolated stack (see tests/e2e/stack.ts). Run with `pnpm test:e2e`. */
export function consoleConfig(stackEnv: Record<string, string> = {}, testMatch = "console.e2e.ts") {
  return defineConfig({
    testDir: "tests/e2e",
    testMatch,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 90_000,
    expect: { timeout: 20_000 },
    reporter: [["list"]],
    outputDir: "test-results/e2e",
    use: {
      baseURL: E2E_BASE_URL,
      // The installed Google Chrome, so no Playwright browser download is needed.
      channel: "chrome",
      viewport: { width: 1280, height: 860 },
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
    },
    webServer: [
      {
        command: "node --import tsx tests/e2e/stack.ts",
        url: `http://127.0.0.1:${E2E_API_PORT}/health`,
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: "ignore",
        stderr: "pipe",
        env: stackEnv,
      },
      {
        command: "pnpm --filter @agentflow/web dev",
        url: E2E_BASE_URL,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          AGENTFLOW_WEB_PORT: String(E2E_WEB_PORT),
          AGENTFLOW_API_PROXY_TARGET: `http://127.0.0.1:${E2E_API_PORT}`,
        },
      },
    ],
  });
}

export default consoleConfig();
