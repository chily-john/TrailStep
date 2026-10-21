import { TrailStepFailureError, validationFailure } from "../../contracts/failures/failure.js";
import { isRecord } from "../../json/guards.js";
import { TRAILSTEP_DIR_NAME } from "../../runtime/artifacts/run-storage.js";

export function throwValidationFailure(diagnostics: readonly string[]): never {
  throw new TrailStepFailureError(
    validationFailure(`Invalid ${TRAILSTEP_DIR_NAME}/config.json.`, { diagnostics }),
  );
}

export function parseOptionalStringArray(
  path: string,
  value: unknown,
  diagnostics: string[],
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    diagnostics.push(`${path} must be an array of strings when present.`);
    return undefined;
  }

  return value;
}

export function parseOptionalStringRecord(
  path: string,
  value: unknown,
  diagnostics: string[],
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return undefined;
  }

  const env: Record<string, string> = {};
  for (const [key, envValue] of Object.entries(value)) {
    if (typeof envValue !== "string") {
      diagnostics.push(`${path}.${key} must be a string.`);
    } else {
      env[key] = envValue;
    }
  }

  return env;
}
