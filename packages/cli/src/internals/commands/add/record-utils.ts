import { isRecord } from "@trailstep/core";

export { isRecord };

export function toMutableRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return { ...value };
}

export function isNodeError(error: unknown): error is { readonly code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
