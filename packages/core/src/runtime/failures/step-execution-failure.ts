import type { Failure } from "../../contracts/failures/failure.js";

import { isFailureLikeError } from "./failure-like.js";

export function stepExecutionFailure(error: unknown): Failure {
  if (isFailureLikeError(error)) {
    return error.failure;
  }

  return {
    code: "step_execution_failed",
    message: error instanceof Error ? error.message : "Step execution failed.",
    ...(error instanceof Error
      ? {
          details: {
            name: error.name,
          },
        }
      : error === undefined
        ? {}
        : { details: { cause: error } }),
  };
}
