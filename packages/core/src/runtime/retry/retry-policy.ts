import type { RetryOnMode } from "./retryable-failures.js";

/**
 * Resolved automatic retry policy for one tier of configuration.
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  /**
   * Which failures may be retried. `transient` (default) retries only the
   * canonical transient failure codes; `always` retries every failure.
   */
  readonly retryOn: RetryOnMode;
}

export interface RetryPolicyInput {
  readonly maxAttempts?: unknown;
  /**
   * Which failures may be retried. `transient` (default) retries only the
   * canonical transient failure codes; `always` retries every failure.
   */
  readonly retryOn?: unknown;
}

export interface ResolveRetryPolicyOptions {
  readonly global?: RetryPolicyInput;
  readonly workflow?: RetryPolicyInput;
  readonly step?: RetryPolicyInput;
}

/**
 * Built-in default applied when no tier configures `maxAttempts`: a failed
 * step attempt is retried once (two attempts total). Configure
 * `settings.retry.maxAttempts` (global), `Workflow.retry` / per-workflow
 * settings (workflow), or `step({ ..., retry })` (step) to change it; set
 * `maxAttempts: 1` to restore single-attempt behavior.
 *
 * `retryOn` defaults to `transient`: only transient failures (timeouts,
 * provider unavailability/failure/spawn errors) are retried. Deterministic
 * failures (schema violations, invalid continuations, exhausted agent
 * targets, ...) fail on the first attempt. Set `retryOn: "always"` to opt
 * into retrying every failure.
 */
const BUILT_IN_RETRY_POLICY: RetryPolicy = { maxAttempts: 2, retryOn: "transient" };

/**
 * Resolves the effective retry policy for a step attempt loop.
 *
 * Precedence is step > workflow > global (`settings.retry`), falling back to
 * the built-in default of `maxAttempts: 2` and `retryOn: "transient"`. Each
 * field is resolved independently: the first tier that configures
 * `maxAttempts` wins, and the first tier that configures `retryOn` wins.
 *
 * The runtime uses the resolved policy to drive durable automatic step
 * retries: a failed attempt is retried only when its failure is retryable
 * under the resolved `retryOn` mode AND attempts remain. Retried attempts
 * emit `step.attemptFailed` (attempt number, failure, and resolved
 * `maxAttempts`); the terminal `step.failed` event is emitted exactly once.
 * Prior attempts are recounted from the persisted event trail on
 * resume/retry, so a crash mid-retry never loses (or grants extra) attempts.
 */
export function resolveRetryPolicy(options: ResolveRetryPolicyOptions): RetryPolicy {
  const tiers = [options.step, options.workflow, options.global];
  const configuredMaxAttempts = tiers.find((policy) => policy?.maxAttempts !== undefined);
  const configuredRetryOn = tiers.find((policy) => policy?.retryOn !== undefined);

  return {
    maxAttempts: validateMaxAttempts(
      configuredMaxAttempts?.maxAttempts ?? BUILT_IN_RETRY_POLICY.maxAttempts,
    ),
    retryOn: validateRetryOn(configuredRetryOn?.retryOn ?? BUILT_IN_RETRY_POLICY.retryOn),
  };
}

export function validateRetryPolicy(input: RetryPolicyInput): RetryPolicy {
  return {
    maxAttempts: validateMaxAttempts(input.maxAttempts ?? BUILT_IN_RETRY_POLICY.maxAttempts),
    retryOn: validateRetryOn(input.retryOn ?? BUILT_IN_RETRY_POLICY.retryOn),
  };
}

function validateMaxAttempts(value: unknown): number {
  const maxAttempts = value;

  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("retry.maxAttempts must be an integer greater than or equal to 1.");
  }

  return maxAttempts;
}

function validateRetryOn(value: unknown): RetryOnMode {
  if (value !== "transient" && value !== "always") {
    throw new TypeError('retry.retryOn must be either "transient" or "always".');
  }

  return value;
}
