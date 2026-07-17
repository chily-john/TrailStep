import { StepKitFailureError, validationFailure } from "../../contracts/failures/failure.js";

export function throwValidationFailure(diagnostics: readonly string[]): never {
  throw new StepKitFailureError(
    validationFailure("Invalid .stepkit/config.json.", { diagnostics }),
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
