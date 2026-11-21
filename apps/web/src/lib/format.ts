// Formatting helpers used everywhere in the console, so relative times, numbers,
// durations, token counts and costs read the same on every page. Pure and unit-tested.

export function shortId(value: string, length = 8): string {
  return value.slice(0, length);
}

const absoluteFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const timeFormatter = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Full timestamp for tooltips and titles, e.g. "Nov 19, 2026, 10:26:19 AM". */
export function formatAbsolute(value: string | null | undefined): string {
  if (!value) return "—";
  return absoluteFormatter.format(new Date(value));
}

export function formatClock(value: string): string {
  return timeFormatter.format(new Date(value));
}

/** "just now", "42s ago", "5m ago", "3h ago", "2d ago", then the absolute date. */
export function formatRelative(value: string | null | undefined, now: number): string {
  if (!value) return "—";
  const seconds = Math.round((now - new Date(value).getTime()) / 1_000);
  if (seconds < 0) {
    const ahead = -seconds;
    if (ahead < 60) return `in ${ahead}s`;
    if (ahead < 3_600) return `in ${Math.round(ahead / 60)}m`;
    return `in ${Math.round(ahead / 3_600)}h`;
  }
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return formatAbsolute(value);
}

/** Milliseconds as "820 ms", "4.2 s", "3m 05s", "1h 02m". */
export function formatDurationMs(milliseconds: number): string {
  const ms = Math.max(0, Math.round(milliseconds));
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 3_600) return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(totalSeconds / 3_600)}h ${String(Math.floor((totalSeconds % 3_600) / 60)).padStart(2, "0")}m`;
}

/** Duration between two timestamps; an open interval runs to `now`. */
export function formatSpan(start: string, end: string | null | undefined, now: number): string {
  return formatDurationMs((end ? new Date(end).getTime() : now) - new Date(start).getTime());
}

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : integer.format(value);
}

/** Compact token count: 980, 12.4K, 3.1M. Null means not reported and is never shown as 0. */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (Math.abs(value) < 10_000) return integer.format(value);
  if (Math.abs(value) < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** USD with enough precision for per-run LLM costs: $0.0042, $1.27, $1,204. */
export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  if (Math.abs(value) < 1_000) return `$${value.toFixed(2)}`;
  return `$${integer.format(value)}`;
}

/** WAITING_APPROVAL -> "Waiting approval". */
export function humanize(value: string): string {
  const words = value.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
