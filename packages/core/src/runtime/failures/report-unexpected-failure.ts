import { errorMessage, isNodeError } from "../../json/guards.js";
import { WorkflowCancellationError } from "../cancellation/cancellation.js";

/**
 * True when the rejection is part of the expected abort/cancellation path
 * (an aborted child process, a timed-out step, a requested workflow
 * cancellation) rather than an unexpected failure.
 */
export function isAbortLikeError(error: unknown): boolean {
  if (error instanceof WorkflowCancellationError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return true;
  }

  return isNodeError(error) && error.code === "ABORT_ERR";
}

/**
 * Surfaces a failure that would otherwise be discarded by a detached
 * promise.
 *
 * Abort/cancellation rejections stay quiet because they are an expected part
 * of the control flow. Any other rejection is reported so it becomes
 * observable instead of silently disappearing.
 */
export function reportUnexpectedFailure(options: {
  readonly error: unknown;
  readonly context: string;
  readonly report?: (error: unknown) => void;
}): void {
  if (isAbortLikeError(options.error)) {
    return;
  }

  if (options.report) {
    options.report(options.error);
    return;
  }

  console.error(
    `TrailStep: unexpected failure during ${options.context}: ${errorMessage(options.error)}`,
  );
}
