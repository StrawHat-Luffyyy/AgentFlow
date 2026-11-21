import type { UsageTotals } from "../api.js";

export const usageRanges = {
  "7d": { label: "Last 7 days", days: 7 },
  "30d": { label: "Last 30 days", days: 30 },
  "90d": { label: "Last 90 days", days: 90 },
} as const;
export type UsageRange = keyof typeof usageRanges;

export function isUsageRange(value: string | null): value is UsageRange {
  return value !== null && value in usageRanges;
}

/** [from, to) for a range ending at the end of today (UTC), so today's bar is complete-to-now. */
export function usageWindow(range: UsageRange, now: number): { from: string; to: string } {
  const today = new Date(now);
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
  return { from: new Date(end - usageRanges[range].days * 86_400_000).toISOString(), to: new Date(end).toISOString() };
}

export interface UsageBreakdown {
  billed: number;
  savedByReplay: number;
  savedByCache: number;
}

/** Billed tokens are what providers charged; replay and cache tokens were avoided and never billed. */
export function breakdown(totals: UsageTotals): UsageBreakdown {
  return {
    billed: totals.billedInputTokens + totals.billedOutputTokens,
    savedByReplay: totals.savedByReplayInputTokens + totals.savedByReplayOutputTokens,
    savedByCache: totals.savedByCacheInputTokens + totals.savedByCacheOutputTokens,
  };
}

/** Share of would-be tokens that were avoided, or null when nothing was spent or saved. */
export function savedShare(value: UsageBreakdown): number | null {
  const avoided = value.savedByReplay + value.savedByCache;
  const total = value.billed + avoided;
  return total === 0 ? null : avoided / total;
}

/** A round axis maximum (1, 2 or 5 × 10ⁿ) at or above the tallest stacked bar. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((candidate) => candidate * magnitude >= value)!;
  return step * magnitude;
}
