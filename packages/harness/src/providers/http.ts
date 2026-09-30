import { ProviderError } from "../errors.js";
import type { JsonObject } from "../types.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export async function providerHttpError(provider: string, response: Response): Promise<ProviderError> {
  let body = "";
  try {
    body = (await response.text()).slice(0, 2_000);
  } catch {
    body = "";
  }
  const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
  return new ProviderError(
    `${provider} request failed with HTTP ${response.status}${body ? `: ${body}` : ""}`,
    retryable ? "TRANSIENT" : "PERMANENT",
    `${provider.toUpperCase()}_HTTP_${response.status}`,
    response.status,
    parseRetryAfter(response.headers.get("retry-after")),
  );
}

export function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError(`${label} was not an object`, "PERMANENT", "MALFORMED_PROVIDER_RESPONSE");
  }
  return value as Record<string, unknown>;
}

export function asJsonObject(value: unknown, label: string): JsonObject {
  const object = asObject(value, label);
  try {
    return JSON.parse(JSON.stringify(object)) as JsonObject;
  } catch (error) {
    throw new ProviderError(`${label} was not JSON-serializable`, "PERMANENT", "MALFORMED_PROVIDER_RESPONSE", null, null, false, { cause: error });
  }
}

export function nullableCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function abortError(provider: string, error: unknown, signal: AbortSignal | undefined): ProviderError {
  const timedOut = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
  return new ProviderError(
    timedOut ? `${provider} request was aborted` : `${provider} request failed before a response was received`,
    timedOut ? "TIMEOUT" : "TRANSIENT",
    timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR",
    null,
    null,
    true,
    { cause: error },
  );
}
