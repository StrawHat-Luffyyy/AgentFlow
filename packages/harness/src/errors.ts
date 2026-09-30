export type ProviderErrorClass = "TRANSIENT" | "PERMANENT" | "TIMEOUT";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly errorClass: ProviderErrorClass,
    readonly code: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
    readonly outcomeUnknown = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderError";
  }
}

export class HarnessValidationError extends Error {
  constructor(message: string, readonly code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HarnessValidationError";
  }
}

export class TurnLimitError extends HarnessValidationError {
  constructor(turn: number, maxTurns: number) {
    super(`Agent turn ${turn} exceeds the configured maximum of ${maxTurns}`, "TURN_LIMIT_EXCEEDED");
    this.name = "TurnLimitError";
  }
}
