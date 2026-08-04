import type { RetryPolicyInput } from "../../runtime/retry/retry-policy.js";
import type { StepKitSettings } from "../targeting.types.js";
import { isRecord } from "./parse-utils.js";

export function parseSettings(
  path: string,
  value: unknown,
  diagnostics: string[],
): StepKitSettings | undefined {
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
    } else if (value.retry.maxAttempts === undefined) {
      delete settings.retry;
    } else {
      settings.retry = { maxAttempts: value.retry.maxAttempts } satisfies RetryPolicyInput;
    }
  }

  if (value.timeout !== undefined && typeof value.timeout !== "number") {
    diagnostics.push(`${path}.timeout must be a number when present.`);
    delete settings.timeout;
  }

  return settings;
}
