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
