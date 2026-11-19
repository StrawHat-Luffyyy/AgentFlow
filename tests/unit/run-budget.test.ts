import { evaluateRunBudget } from "../../packages/runtime/src/index.ts";
import { modelPriceTableSchema, usageCostUsd } from "@agentflow/shared";
import { describe, expect, it } from "vitest";
import { ExitCode } from "../../apps/cli/src/errors.js";
import { stopCode } from "../../apps/cli/src/watch.js";
import { budgetFromText, budgetLabel } from "../../apps/web/src/new-run.js";

const record = (inputTokens: number | null, outputTokens: number | null, cachedInputTokens: number | null = 0) => ({
  provider: "gemini", model: "gemini-3.5-flash", inputTokens, outputTokens, cachedInputTokens,
});

describe("usageCostUsd", () => {
  it("bills cached input at the cached rate and the rest at the input rate", () => {
    const price = { inputPer1M: 2, cachedInputPer1M: 0.5, outputPer1M: 10 };
    // (1_000_000 - 400_000) * 2 + 400_000 * 0.5 + 100_000 * 10 = 1.2M + 0.2M + 1M => $2.40
    expect(usageCostUsd(record(1_000_000, 100_000, 400_000), price)).toBeCloseTo(2.4, 9);
  });

  it("falls back to the input rate without a cached price and never estimates missing counts", () => {
    expect(usageCostUsd(record(1_000_000, 0, 500_000), { inputPer1M: 3, outputPer1M: 9 })).toBeCloseTo(3, 9);
    expect(usageCostUsd(record(null, null), { inputPer1M: 3, outputPer1M: 9 })).toBeNull();
  });
});

describe("modelPriceTableSchema", () => {
  it("accepts provider/model keys and rejects malformed entries", () => {
    expect(modelPriceTableSchema.parse({ "groq/openai/gpt-oss-120b": { inputPer1M: 0.15, outputPer1M: 0.6 } }))
      .toEqual({ "groq/openai/gpt-oss-120b": { inputPer1M: 0.15, outputPer1M: 0.6 } });
    expect(modelPriceTableSchema.safeParse({ "no-provider": { inputPer1M: 1, outputPer1M: 1 } }).success).toBe(false);
    expect(modelPriceTableSchema.safeParse({ "a/b": { inputPer1M: -1, outputPer1M: 1 } }).success).toBe(false);
    expect(modelPriceTableSchema.safeParse({ "a/b": { inputPer1M: 1, outputPer1M: 1, extra: 1 } }).success).toBe(false);
  });
});

describe("evaluateRunBudget", () => {
  const tokens = { maxTokens: 100, maxCostUsd: null };

  it("stops before a call at the limit but lets a response land exactly on it", () => {
    const usage = [record(60, 40)];
    expect(evaluateRunBudget("before-call", tokens, usage, null)).toMatchObject({ exceeded: true, tokensUsed: 100 });
    expect(evaluateRunBudget("after-response", tokens, usage, null)).toMatchObject({ exceeded: false, tokensUsed: 100 });
    expect(evaluateRunBudget("after-response", tokens, [record(61, 40)], null).exceeded).toBe(true);
  });

  it("counts unreported calls separately instead of guessing their tokens", () => {
    expect(evaluateRunBudget("before-call", tokens, [record(10, 5), record(null, null)], null))
      .toMatchObject({ exceeded: false, tokensUsed: 15, unreportedCalls: 1 });
  });

  it("enforces cost from the run's price snapshot", () => {
    const prices = { "gemini/gemini-3.5-flash": { inputPer1M: 1_000, outputPer1M: 1_000 } };
    const check = evaluateRunBudget("after-response", { maxTokens: null, maxCostUsd: 0.05 }, [record(40, 20)], prices);
    expect(check.costUsd).toBeCloseTo(0.06, 9);
    expect(check.exceeded).toBe(true);
    expect(evaluateRunBudget("after-response", { maxTokens: null, maxCostUsd: 0.07 }, [record(40, 20)], prices).exceeded).toBe(false);
  });
});

describe("budget surfaces", () => {
  it("maps BUDGET_EXCEEDED to its own CLI exit code", () => {
    expect(ExitCode.RUN_BUDGET_EXCEEDED).toBe(15);
    expect(stopCode("BUDGET_EXCEEDED", false)).toBe(15);
  });

  it("parses optional dashboard budget fields", () => {
    expect(budgetFromText("", "tokens")).toEqual({ ok: true, value: undefined });
    expect(budgetFromText("5000", "tokens")).toEqual({ ok: true, value: 5000 });
    expect(budgetFromText("12.5", "tokens").ok).toBe(false);
    expect(budgetFromText("0.25", "usd")).toEqual({ ok: true, value: 0.25 });
    expect(budgetFromText("0", "usd").ok).toBe(false);
    expect(budgetLabel({ maxTokens: 5000, maxCostUsd: 0.25 })).toBe("5,000 tokens · $0.25");
    expect(budgetLabel({ maxTokens: null, maxCostUsd: null })).toBeNull();
  });
});
