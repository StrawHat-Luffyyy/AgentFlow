import { readFile } from "node:fs/promises";
import type { ZodType, ZodTypeDef } from "zod";
import { UsageError } from "./errors.js";
import type { CliIO } from "./io.js";
import { readStdin } from "./prompt.js";

/** Reads JSON from a file path, or from stdin when `source` is "-". */
export async function readJsonSource(io: CliIO, source: string): Promise<unknown> {
  const label = source === "-" ? "stdin" : source;
  let text: string;
  try {
    text = source === "-" ? await readStdin(io) : await readFile(source, "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Applies `key=value` overrides; values are parsed as JSON when possible, else kept as strings. */
export function applySets(base: Record<string, unknown>, sets: readonly string[]): Record<string, unknown> {
  const result = { ...base };
  for (const entry of sets) {
    const index = entry.indexOf("=");
    if (index <= 0) throw new UsageError(`--set expects key=value, got "${entry}"`);
    const raw = entry.slice(index + 1);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    result[entry.slice(0, index)] = value;
  }
  return result;
}

/** Validates a request body with a shared schema before it is sent. */
export function validateRequest<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `  ${issue.path.length > 0 ? issue.path.join(".") : "(body)"}: ${issue.message}`)
    .join("\n");
  throw new UsageError(`Invalid request:\n${issues}`, result.error.issues);
}

export function parsePositiveInt(name: string, text: string): number {
  if (!/^\d+$/.test(text) || Number(text) < 1) throw new UsageError(`${name} must be a positive integer, got "${text}"`);
  return Number(text);
}

export function parseNonNegativeInt(name: string, text: string): number {
  if (!/^\d+$/.test(text)) throw new UsageError(`${name} must be a non-negative integer, got "${text}"`);
  return Number(text);
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
