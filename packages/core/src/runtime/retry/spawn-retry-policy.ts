/**
 * Retry policy for transient working-agent spawn failures (process-level
 * deaths such as Windows `STATUS_DLL_INIT_FAILED`, resource-exhausted spawn
 * errors). Backoff delays grow exponentially with jitter so retry bursts do
 * not re-create the spawn storms that trigger the underlying OS failures.
 */
export interface SpawnRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly maxDelayMs: number;
}

export interface SpawnRetryPolicyInput {
  readonly maxAttempts?: unknown;
  readonly baseDelayMs?: unknown;
  readonly factor?: unknown;
  readonly maxDelayMs?: unknown;
}

export interface ResolveSpawnRetryPolicyOptions {
  readonly global?: SpawnRetryPolicyInput;
  readonly workflow?: SpawnRetryPolicyInput;
  readonly step?: SpawnRetryPolicyInput;
}

export const BUILT_IN_SPAWN_RETRY_POLICY: SpawnRetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 2_000,
  factor: 3,
  maxDelayMs: 60_000,
};

export function resolveSpawnRetryPolicy(
  options: ResolveSpawnRetryPolicyOptions = {},
): SpawnRetryPolicy {
  return validateSpawnRetryPolicy(
    firstConfiguredPolicy(options.step, options.workflow, options.global) ?? {},
  );
}

export function validateSpawnRetryPolicy(input: SpawnRetryPolicyInput): SpawnRetryPolicy {
  const maxAttempts = input.maxAttempts ?? BUILT_IN_SPAWN_RETRY_POLICY.maxAttempts;
  const baseDelayMs = input.baseDelayMs ?? BUILT_IN_SPAWN_RETRY_POLICY.baseDelayMs;
  const factor = input.factor ?? BUILT_IN_SPAWN_RETRY_POLICY.factor;
  const maxDelayMs = input.maxDelayMs ?? BUILT_IN_SPAWN_RETRY_POLICY.maxDelayMs;

  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("spawnRetry.maxAttempts must be an integer greater than or equal to 1.");
  }
  if (typeof baseDelayMs !== "number" || !Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new TypeError("spawnRetry.baseDelayMs must be a non-negative finite number.");
  }
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 1) {
    throw new TypeError("spawnRetry.factor must be a finite number greater than or equal to 1.");
  }
  if (typeof maxDelayMs !== "number" || !Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new TypeError("spawnRetry.maxDelayMs must be a non-negative finite number.");
  }

  return { maxAttempts, baseDelayMs, factor, maxDelayMs };
}

/**
 * Backoff delay before retry `retryIndex` (1-based): equal jitter over
 * `min(maxDelayMs, baseDelayMs * factor^(retryIndex - 1))`, so every wait is
 * at least half the nominal delay (spacing retries apart) and at most the cap.
 */
export function spawnRetryDelayMs(
  policy: SpawnRetryPolicy,
  retryIndex: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, retryIndex - 1);
  const nominal = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.factor ** exponent);
  return Math.round(nominal / 2 + random() * (nominal / 2));
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function firstConfiguredPolicy(
  ...policies: readonly (SpawnRetryPolicyInput | undefined)[]
): SpawnRetryPolicyInput | undefined {
  return policies.find((policy) => policy !== undefined && Object.keys(policy).length > 0);
}
