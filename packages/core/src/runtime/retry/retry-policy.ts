export interface RetryPolicy {
  readonly maxAttempts: number;
}

export interface RetryPolicyInput {
  readonly maxAttempts?: unknown;
}

export interface ResolveRetryPolicyOptions {
  readonly global?: RetryPolicyInput;
  readonly workflow?: RetryPolicyInput;
  readonly step?: RetryPolicyInput;
}

const BUILT_IN_RETRY_POLICY: RetryPolicy = { maxAttempts: 2 };

export function resolveRetryPolicy(options: ResolveRetryPolicyOptions): RetryPolicy {
  return validateRetryPolicy(
    firstConfiguredPolicy(options.step, options.workflow, options.global) ?? BUILT_IN_RETRY_POLICY,
  );
}

export function validateRetryPolicy(input: RetryPolicyInput): RetryPolicy {
  const maxAttempts = input.maxAttempts ?? BUILT_IN_RETRY_POLICY.maxAttempts;

  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("retry.maxAttempts must be an integer greater than or equal to 1.");
  }

  return { maxAttempts };
}

function firstConfiguredPolicy(
  ...policies: readonly (RetryPolicyInput | undefined)[]
): RetryPolicyInput | undefined {
  return policies.find((policy) => policy?.maxAttempts !== undefined);
}
