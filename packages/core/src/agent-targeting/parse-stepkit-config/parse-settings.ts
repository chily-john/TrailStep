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

  if (value.retry !== undefined && !isRecord(value.retry)) {
    diagnostics.push(`${path}.retry must be an object when present.`);
  }

  if (value.timeout !== undefined && typeof value.timeout !== "number") {
    diagnostics.push(`${path}.timeout must be a number when present.`);
  }

  return value as StepKitSettings;
}
