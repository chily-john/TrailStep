export interface Failure {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
  /**
   * Opt-in marker that makes this failure retryable even when its code is
   * not part of the canonical transient allowlist. See
   * `runtime/retry/retryable-failures.ts`.
   */
  readonly retryable?: boolean;
}

export class TrailStepFailureError extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super(failure.message);
    this.name = "TrailStepFailureError";
    this.failure = failure;
  }
}

export function validationFailure(message: string, details?: unknown): Failure {
  return {
    code: "validation_failed",
    message,
    ...(details === undefined ? {} : { details }),
  };
}

/**
 * True when `error` carries a complete structured failure (a `failure` object
 * with a string `code` and a string `message`).
 */
export function isFailureLikeError(error: unknown): error is { readonly failure: Failure } {
  return (
    typeof error === "object" &&
    error !== null &&
    "failure" in error &&
    typeof error.failure === "object" &&
    error.failure !== null &&
    "code" in error.failure &&
    typeof error.failure.code === "string" &&
    "message" in error.failure &&
    typeof error.failure.message === "string"
  );
}

/**
 * Reads the failure code of a failure-like value.
 *
 * `isFailureLikeError` requires a complete structured failure (code *and*
 * message). Callers that only care about the code — for example to map a
 * specific failure onto a recovery path — need a tolerant variant: failures
 * that crossed a serialization boundary can lose the message while keeping
 * the code. Returns `undefined` when the value carries no string failure
 * code.
 */
export function readFailureCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("failure" in error)) {
    return undefined;
  }

  const failure: unknown = error.failure;
  if (typeof failure !== "object" || failure === null || !("code" in failure)) {
    return undefined;
  }

  const code: unknown = failure.code;
  return typeof code === "string" ? code : undefined;
}
