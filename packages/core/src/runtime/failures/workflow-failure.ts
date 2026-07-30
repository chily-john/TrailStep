import type { Failure } from "../../contracts/failures/failure.js";

import { isFailureLikeError } from "./failure-like.js";

export function workflowFailure(error: unknown): Failure {
  if (isFailureLikeError(error)) {
    return error.failure;
  }

  return {
    code: "workflow_failed",
    message: error instanceof Error ? error.message : "Unknown workflow failure.",
    ...(error === undefined ? {} : { details: { cause: error } }),
  };
}
