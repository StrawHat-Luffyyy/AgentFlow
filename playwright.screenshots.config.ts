import { consoleConfig } from "./playwright.config.ts";

/**
 * README screenshots (`pnpm screenshots`). The first worker crashes right after the
 * analyze-features LLM response is journalled (the E2B boundary); its replacement replays it.
 */
export default consoleConfig({
  E2E_FAULT_PLAN: JSON.stringify([
    { id: "screenshot-e2b", hook: "after-llm-journal-commit", action: "crash", operationId: "analyze-features", occurrence: 1 },
  ]),
}, "screenshots.e2e.ts");
