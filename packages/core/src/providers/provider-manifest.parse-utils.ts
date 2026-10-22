import type { WorkflowAgentThinking } from "../contracts/agents/agent-role.types.js";
import { isRecord } from "../json/guards.js";

export const THINKING_LEVELS = new Set<WorkflowAgentThinking>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function parseSupportedObject(
  path: string,
  value: unknown,
  diagnostics: string[],
): { readonly supported: boolean; readonly reason?: string } | undefined {
  if (!isRecord(value) || typeof value.supported !== "boolean") {
    diagnostics.push(`${path} must be an object with a boolean supported field.`);
    return undefined;
  }
  return {
    supported: value.supported,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

export function parseRequiredString(
  path: string,
  value: unknown,
  diagnostics: string[],
): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    diagnostics.push(`${path} must be a non-empty string.`);
    return undefined;
  }
  return value;
}

export function parseRequiredStringArray(
  path: string,
  value: unknown,
  diagnostics: string[],
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    diagnostics.push(`${path} must be an array of strings.`);
    return undefined;
  }
  return value;
}

export function parseOptionalNonEmptyString(
  path: string,
  value: unknown,
  diagnostics: string[],
): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    diagnostics.push(`${path} must be a non-empty string when present.`);
    return null;
  }
  return value;
}
