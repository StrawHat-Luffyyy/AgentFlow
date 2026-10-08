export const ExitCode = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  CONFLICT: 5,
  RUN_FAILED: 10,
  RUN_CANCELLED: 11,
  RUN_WAITING: 12,
  WATCH_TIMEOUT: 13,
  RUN_TIMED_OUT: 14,
  INTERRUPTED: 130,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UsageError extends CliError {
  constructor(message: string, details?: unknown) {
    super(message, ExitCode.USAGE, "USAGE", details);
  }
}

export interface ApiErrorContext {
  method: string;
  path: string;
  authType?: "token" | "session";
  resource?: { kind: string; id: string };
  requiredRole?: string;
}

export class ApiError extends CliError {
  constructor(
    message: string,
    exitCode: number,
    code: string,
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
    details?: unknown,
  ) {
    super(message, exitCode, code, details);
  }
}

function describeIssues(details: unknown): string | undefined {
  if (!Array.isArray(details)) return undefined;
  const lines = details.map((issue: { path?: unknown; message?: unknown }) => {
    const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join(".") : "(body)";
    return `  ${path}: ${String(issue.message ?? "invalid")}`;
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Maps a non-2xx API response to the CLI's message and exit-code contract. */
export function apiError(status: number, body: unknown, context: ApiErrorContext): ApiError {
  const payload = (typeof body === "object" && body !== null ? body : {}) as {
    error?: unknown;
    message?: unknown;
    details?: unknown;
  };
  const code = typeof payload.error === "string" ? payload.error : `HTTP_${status}`;
  const serverMessage = typeof payload.message === "string" ? payload.message : undefined;
  const make = (message: string, exitCode: number) =>
    new ApiError(message, exitCode, code, status, context.method, context.path, body, payload.details);

  if (status === 400 && code === "VALIDATION_ERROR") {
    const issues = describeIssues(payload.details);
    return make(issues ? `Request rejected by the API:\n${issues}` : "Request rejected by the API", ExitCode.USAGE);
  }
  if (status === 401) {
    return make(
      context.authType === "session"
        ? "Session expired — run `agentflow login`"
        : "Not logged in or session expired — run `agentflow login`",
      ExitCode.AUTH,
    );
  }
  if (status === 403) {
    return make(
      context.requiredRole ? `Forbidden — this action requires role \`${context.requiredRole}\`` : "Forbidden",
      ExitCode.AUTH,
    );
  }
  if (status === 404) {
    return make(
      context.resource
        ? `${context.resource.kind} ${context.resource.id} not found (or not owned by you)`
        : `Not found: ${context.method} ${context.path}`,
      ExitCode.NOT_FOUND,
    );
  }
  if (status === 409) return make(serverMessage ?? "Conflict", ExitCode.CONFLICT);
  if (status >= 400 && status < 500) {
    return make(serverMessage ? `${code}: ${serverMessage}` : code, ExitCode.USAGE);
  }
  return make(`Server error (${status})${typeof payload.error === "string" ? `: ${payload.error}` : ""}`, ExitCode.ERROR);
}
