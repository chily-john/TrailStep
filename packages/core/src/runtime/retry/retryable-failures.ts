import type { Failure } from "../../contracts/failures/failure.js";

/**
 * Which failures automatic step retry is allowed to re-run.
 *
 * - `transient` (default): only failures classified as transient are retried.
 * - `always`: every failure is retried (opt-in escape hatch for steps that are
 *   known to be safe to re-run, e.g. idempotent read-only work).
 */
export type RetryOnMode = "transient" | "always";

/**
 * Canonical allowlist of TRANSIENT failure codes.
 *
 * This is an ALLOWLIST on purpose: any failure code that is not listed here is
 * treated as PERMANENT and is therefore never retried automatically. New
 * failure codes introduced later default to "not retried", which is the safe
 * direction — a deterministic failure must not burn a second agent dispatch.
 *
 * Transient codes:
 * - `step_timeout` — the step exceeded its effective timeout.
 * - `agent_provider_unavailable` — the provider/target could not be reached.
 * - `agent_provider_failed` — the provider process failed while running.
 * - `agent_provider_spawn_error` — the provider process could not be spawned.
 * - `agent_provider_timeout` — the provider process timed out.
 *
 * Everything else is permanent, including (but not limited to):
 * `validation_failed`, `agent_output_invalid_json`, `invalid_continuation`,
 * `unsupported_continuation`, `missing_agent_config`,
 * `agent_targets_unavailable`, `agent_provider_interactive_unsupported`,
 * `review_rejected`, `agent_target_exhausted`, `step_execution_failed`,
 * `branch_failed`, `concurrent_branch_failed`, `step_attempts_exhausted`,
 * `run_name_invalid`, and every `resume_*` / `retry_*` code.
 *
 * A failure may also opt in explicitly by setting `retryable: true` (or
 * `details.retryable === true`), regardless of its code.
 */
export const TRANSIENT_FAILURE_CODES: readonly string[] = [
  "step_timeout",
  "agent_provider_unavailable",
  "agent_provider_failed",
  "agent_provider_spawn_error",
  "agent_provider_timeout",
];

const TRANSIENT_FAILURE_CODE_SET: ReadonlySet<string> = new Set(TRANSIENT_FAILURE_CODES);

/**
 * Canonical retryability classifier for a single step failure.
 *
 * Returns `true` only for TRANSIENT failures (or failures explicitly marked
 * retryable). Everything else — including failure codes this module has never
 * seen — is permanent and must not be retried automatically.
 */
export function isRetryableStepFailure(failure: Failure): boolean {
  if (isExplicitlyRetryable(failure)) {
    return true;
  }

  return TRANSIENT_FAILURE_CODE_SET.has(failure.code);
}

/**
 * Whether the automatic step retry loop should re-run a step after `failure`.
 *
 * `retryOn: "transient"` (the default) defers to {@link isRetryableStepFailure};
 * `retryOn: "always"` opts into retrying every failure.
 */
export function shouldRetryStepFailure(failure: Failure, retryOn: RetryOnMode): boolean {
  if (retryOn === "always") {
    return true;
  }

  return isRetryableStepFailure(failure);
}

/** Whether a failure is explicitly marked as retryable by its producer. */
export function isExplicitlyRetryable(failure: Failure): boolean {
  if (failure.retryable === true) {
    return true;
  }

  const details = failure.details;
  if (typeof details !== "object" || details === null) {
    return false;
  }

  return (details as { readonly retryable?: unknown }).retryable === true;
}
