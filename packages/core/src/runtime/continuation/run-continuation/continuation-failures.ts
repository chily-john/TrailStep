import { isAbsoluteDoneNode, isAbsoluteFailNode } from "../../../authoring/step/step-node.js";
import type { Failure } from "../../../contracts/failures/failure.js";
import { TrailStepFailureError } from "../../../contracts/failures/failure.js";
import { stepExecutionFailure } from "../../failures/step-execution-failure.js";

export function errorMessage(error: unknown): string {
  if (error instanceof TrailStepFailureError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Error continuation failed.";
}

export function continuationFailure(source: string): Failure {
  return {
    code: "invalid_continuation",
    message: `${source} returned an invalid continuation node.`,
  };
}

export function exhaustedStepAttemptFailure(options: {
  readonly stepId: string;
  readonly attemptFailures: number;
  readonly maxAttempts: number;
  readonly recordedFailure?: Failure;
}): Failure {
  return {
    code: "step_attempts_exhausted",
    message: `Step ${options.stepId} already consumed its retry budget (${options.attemptFailures} recorded failed attempt(s), maxAttempts ${options.maxAttempts}); refusing to re-execute it. Raise the retry budget (settings.retry.maxAttempts or step/workflow retry config), or start a fresh run.`,
    ...(options.recordedFailure === undefined
      ? {}
      : { details: { lastFailure: options.recordedFailure } }),
  };
}

export function failureFromError(error: unknown): Failure {
  if (error instanceof TrailStepFailureError) {
    return error.failure;
  }

  return stepExecutionFailure(error);
}

export function unsupportedContinuationFailure(node: unknown, source: string): Failure | undefined {
  const form = unsupportedContinuationForm(node);
  if (form === undefined) {
    return undefined;
  }

  return {
    code: "unsupported_continuation",
    message: `${source} returned ${form}, but parallel tracks/workflow invocation execution is not implemented yet.`,
  };
}

function unsupportedContinuationForm(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    return "a continuation array";
  }

  if (isAbsoluteDoneNode(node)) {
    return "an absolute done continuation";
  }

  if (isAbsoluteFailNode(node)) {
    return "an absolute fail continuation";
  }

  return undefined;
}
