import { isRecord } from "@trailstep/core";

export { isRecord };

export function toMutableRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return { ...value };
}
