export interface TimeoutPolicy {
  readonly timeoutMs?: number;
}

export type TimeoutPolicyInput = number;

export interface ResolveTimeoutPolicyOptions {
  readonly global?: TimeoutPolicyInput;
  readonly workflow?: TimeoutPolicyInput;
  readonly step?: TimeoutPolicyInput;
}

const BUILT_IN_TIMEOUT_POLICY: TimeoutPolicy = {};

export function resolveTimeoutPolicy(options: ResolveTimeoutPolicyOptions): TimeoutPolicy {
  const configured = firstConfiguredPolicy(options.step, options.workflow, options.global);
  return configured !== undefined ? validateTimeoutPolicy(configured) : BUILT_IN_TIMEOUT_POLICY;
}

export interface StallPolicy {
  readonly stallTimeoutMs?: number;
}

/**
 * Resolves the opt-in stall timeout with step > workflow > global precedence.
 * There is deliberately no built-in default: an unconfigured stall timeout
 * stays absent so stall detection is off unless an operator asks for it.
 */
export function resolveStallPolicy(options: {
  readonly global?: unknown;
  readonly workflow?: unknown;
  readonly step?: unknown;
}): StallPolicy {
  const configured = firstConfiguredPolicy(options.step, options.workflow, options.global);
  if (configured === undefined) {
    return {};
  }

  if (typeof configured !== "number" || !Number.isInteger(configured) || configured < 1) {
    throw new TypeError(
      "stallTimeout must be an integer number of milliseconds greater than or equal to 1.",
    );
  }

  return { stallTimeoutMs: configured };
}

export function validateTimeoutPolicy(input: unknown): TimeoutPolicy {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1) {
    throw new TypeError(
      "timeout must be an integer number of milliseconds greater than or equal to 1.",
    );
  }

  return { timeoutMs: input };
}

function firstConfiguredPolicy(...policies: readonly unknown[]): unknown | undefined {
  return policies.find((policy) => policy !== undefined);
}
