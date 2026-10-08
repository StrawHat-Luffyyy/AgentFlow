import { UsageError } from "../errors.js";

const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(text: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(text.trim());
  if (!match) {
    throw new UsageError(`Invalid duration "${text}" — use a number with a unit, e.g. 500ms, 90s, 5m, 1h, 2d`);
  }
  return Number(match[1]) * UNITS[match[2]!]!;
}

export function formatRelative(value: string | Date, now: number): string {
  const delta = now - new Date(value).getTime();
  const seconds = Math.floor(Math.abs(delta) / 1_000);
  if (seconds < 10) return "just now";
  const amount = seconds < 60 ? `${seconds}s`
    : seconds < 3_600 ? `${Math.floor(seconds / 60)}m`
      : seconds < 86_400 ? `${Math.floor(seconds / 3_600)}h`
        : `${Math.floor(seconds / 86_400)}d`;
  return delta >= 0 ? `${amount} ago` : `in ${amount}`;
}
