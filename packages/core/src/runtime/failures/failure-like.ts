import type { Failure } from "../../contracts/failures/failure.js";

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
