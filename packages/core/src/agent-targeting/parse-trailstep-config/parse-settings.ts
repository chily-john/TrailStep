import type { RetryPolicyInput } from "../../runtime/retry/retry-policy.js";
import type { TrailStepSettings } from "../targeting.types.js";
import { isRecord } from "./parse-utils.js";

export function parseSettings(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepSettings | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return undefined;
  }

  const settings: Record<string, unknown> = { ...value };

  if (value.retry !== undefined) {
    if (!isRecord(value.retry)) {
      diagnostics.push(`${path}.retry must be an object when present.`);
      delete settings.retry;
    } else if (value.retry.maxAttempts === undefined && value.retry.retryOn === undefined) {
      delete settings.retry;
    } else {
      const retry: RetryPolicyInput = {
        ...(value.retry.maxAttempts === undefined ? {} : { maxAttempts: value.retry.maxAttempts }),
        ...(value.retry.retryOn === undefined ? {} : { retryOn: value.retry.retryOn }),
      };
      settings.retry = retry;
    }
  }

  if (value.timeout !== undefined && typeof value.timeout !== "number") {
    diagnostics.push(`${path}.timeout must be a number when present.`);
    delete settings.timeout;
  }

  return settings;
}
