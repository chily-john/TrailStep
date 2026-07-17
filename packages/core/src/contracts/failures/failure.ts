export interface Failure {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export class StepKitFailureError extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super(failure.message);
    this.name = "StepKitFailureError";
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
