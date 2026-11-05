import type { ErrorCode } from "./types";

/** Default retryability per error code; callers may override per error. */
const RETRYABLE: Record<ErrorCode, boolean> = {
  auth: false,
  rate_limit: true,
  timeout: true,
  network: true,
  bad_response: false,
  aborted: false,
  unknown: false,
};

export interface ProviderErrorOptions {
  /** Overrides the per-code default. */
  retryable?: boolean;
  /** HTTP status, when the error came from a response. */
  status?: number;
  cause?: unknown;
}

/**
 * A normalized provider failure. Messages must never contain the API key
 * (see `redact` in `providers/openai.ts`), and headers are never logged.
 */
export class ProviderError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(code: ErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE[code];
    if (options.status !== undefined) this.status = options.status;
  }
}
