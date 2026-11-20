import { describe, expect, it } from "vitest";
import {
  formatCost, formatDurationMs, formatNumber, formatRelative, formatSpan, formatTokens, humanize, shortId,
} from "../../apps/web/src/lib/format.js";
import { deriveRecoveryEvents, historyTone } from "../../apps/web/src/lib/recovery.js";
import { isFiltered, parseRunListQuery, serializeRunListQuery, toApiFilters } from "../../apps/web/src/lib/run-filters.js";
import { parseReceipt } from "../../apps/web/src/lib/reconcile.js";
import { breakdown, niceMax, savedShare, usageWindow } from "../../apps/web/src/lib/usage.js";

describe("console formatting", () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const ago = (seconds: number) => new Date(now - seconds * 1_000).toISOString();

  it("formats relative times on one scale", () => {
    expect(formatRelative(ago(2), now)).toBe("just now");
    expect(formatRelative(ago(42), now)).toBe("42s ago");
    expect(formatRelative(ago(5 * 60 + 10), now)).toBe("5m ago");
    expect(formatRelative(ago(3 * 3_600), now)).toBe("3h ago");
    expect(formatRelative(ago(2 * 86_400), now)).toBe("2d ago");
    expect(formatRelative(new Date(now + 30_000).toISOString(), now)).toBe("in 30s");
    expect(formatRelative(null, now)).toBe("—");
  });

  it("formats durations, numbers, tokens and costs", () => {
    expect(formatDurationMs(820)).toBe("820 ms");
    expect(formatDurationMs(4_200)).toBe("4.2 s");
    expect(formatDurationMs(185_000)).toBe("3m 05s");
    expect(formatDurationMs(3_720_000)).toBe("1h 02m");
    expect(formatSpan(ago(10), null, now)).toBe("10.0 s");
    expect(formatNumber(12_345)).toBe("12,345");
    expect(formatNumber(null)).toBe("—");
    expect(formatTokens(980)).toBe("980");
    expect(formatTokens(12_400)).toBe("12.4K");
    expect(formatTokens(3_100_000)).toBe("3.1M");
    expect(formatTokens(null)).toBe("—");
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(1.27)).toBe("$1.27");
    expect(formatCost(null)).toBe("—");
    expect(humanize("WAITING_APPROVAL")).toBe("Waiting approval");
    expect(shortId("d9c0bc70-d060-433f-851f-049f6032c67a")).toBe("d9c0bc70");
  });
});

describe("recovery events", () => {
  const event = (sequence: number, type: string, payload: unknown = {}) => ({
    id: `e${sequence}`, sequence, stepId: "s1", type, payload, createdAt: "2026-11-20T12:00:00.000Z",
  });

  it("keeps only recovery-relevant events, oldest first, with plain explanations", () => {
    const events = deriveRecoveryEvents([
      event(5, "LLM_JOURNAL_REPLAYED", { inputTokens: 1_365, outputTokens: 177 }),
      event(1, "RUN_CREATED"),
      event(3, "LEASE_EXPIRED", { expiredEpoch: 1, retryScheduled: true }),
      event(4, "OPERATION_SUCCEEDED"),
      event(7, "RUN_BUDGET_EXCEEDED", { tokensUsed: 359, maxTokens: 300 }),
    ]);
    expect(events.map((item) => [item.sequence, item.label, item.tone])).toEqual([
      [3, "Lease expired", "warning"],
      [5, "Replayed from journal", "success"],
      [7, "Budget exceeded", "danger"],
    ]);
    expect(events[0]!.description).toContain("epoch 1");
    expect(events[1]!.description).toContain("1,542 tokens");
    expect(events[2]!.description).toContain("359 of 300 tokens");
  });

  it("tones ordinary history events", () => {
    expect(historyTone("OPERATION_SUCCEEDED")).toBe("success");
    expect(historyTone("APPROVAL_REJECTED")).toBe("danger");
    expect(historyTone("OPERATION_RETRY_SCHEDULED")).toBe("warning");
    expect(historyTone("SOMETHING_ELSE")).toBe("neutral");
  });
});

describe("runs list filters", () => {
  const workflow = "11111111-2222-4333-8444-555555555555";

  it("round-trips through the URL and ignores junk", () => {
    const query = parseRunListQuery(new URLSearchParams(`status=failed&workflow=${workflow}&range=7d&other=keep`));
    expect(query).toEqual({ status: "failed", workflow, range: "7d" });
    expect(serializeRunListQuery(query, new URLSearchParams("other=keep")).toString()).toBe(`other=keep&status=failed&workflow=${workflow}&range=7d`);
    expect(parseRunListQuery(new URLSearchParams("status=bogus&workflow=not-a-uuid&range=1y"))).toEqual({ status: "all", workflow: "", range: "any" });
    expect(serializeRunListQuery({ status: "all", workflow: "", range: "any" }).toString()).toBe("");
    expect(isFiltered({ status: "all", workflow: "", range: "any" })).toBe(false);
  });

  it("maps presets to API filters", () => {
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    expect(toApiFilters({ status: "failed", workflow, range: "24h" }, now)).toEqual({
      status: ["FAILED", "TIMED_OUT", "BUDGET_EXCEEDED"],
      workflowId: workflow,
      from: "2026-11-19T12:00:00.000Z",
    });
    expect(toApiFilters({ status: "all", workflow: "", range: "any" }, now)).toEqual({});
  });
});

describe("console usage page helpers", () => {
  const totals = {
    billedCalls: 4, unreportedCalls: 0, billedInputTokens: 600, billedOutputTokens: 150,
    billedCachedInputTokens: 0, billedReasoningTokens: 0, replayedCalls: 1, savedByReplayInputTokens: 150,
    savedByReplayOutputTokens: 50, cacheHitCalls: 1, savedByCacheInputTokens: 40, savedByCacheOutputTokens: 10,
  };

  it("keeps billed tokens apart from tokens avoided by replay and by cache", () => {
    expect(breakdown(totals)).toEqual({ billed: 750, savedByReplay: 200, savedByCache: 50 });
    expect(savedShare(breakdown(totals))).toBeCloseTo(0.25);
    expect(savedShare({ billed: 0, savedByReplay: 0, savedByCache: 0 })).toBeNull();
  });

  it("picks round axis maxima and whole UTC-day windows ending tomorrow at midnight", () => {
    expect([0, 1, 7, 12, 260, 4_100, 50_000].map(niceMax)).toEqual([1, 1, 10, 20, 500, 5_000, 50_000]);
    const window = usageWindow("7d", Date.parse("2026-11-20T15:30:00.000Z"));
    expect(window).toEqual({ from: "2026-11-14T00:00:00.000Z", to: "2026-11-21T00:00:00.000Z" });
  });

  it("accepts only a JSON object as a reconciliation receipt", () => {
    expect(parseReceipt('{"status":"published"}')).toEqual({ ok: true, value: { status: "published" } });
    expect(parseReceipt("[1]").ok).toBe(false);
    expect(parseReceipt("null").ok).toBe(false);
    expect(parseReceipt("{oops").ok).toBe(false);
  });
});
