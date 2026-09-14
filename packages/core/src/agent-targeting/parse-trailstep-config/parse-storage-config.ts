import { parseStorageLifecycleDurationDays } from "../../runtime/storage-lifecycle/storage-lifecycle.js";
import type { TrailStepStorageConfig } from "../targeting.types.js";
import { isRecord, parseOptionalStringArray } from "./parse-utils.js";

const VALID_RUN_ON = new Set(["run", "open", "runs"]);

export function parseStorageConfig(
  value: unknown,
  diagnostics: string[],
): TrailStepStorageConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push("storage must be an object when present.");
    return undefined;
  }

  const lifecycle = parseLifecycleConfig(value.lifecycle, diagnostics);
  return lifecycle === undefined ? {} : { lifecycle };
}

function parseLifecycleConfig(
  value: unknown,
  diagnostics: string[],
): NonNullable<TrailStepStorageConfig["lifecycle"]> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push("storage.lifecycle must be an object when present.");
    return undefined;
  }

  const runOn = parseOptionalStringArray("storage.lifecycle.runOn", value.runOn, diagnostics);
  if (runOn !== undefined) {
    for (const entry of runOn) {
      if (!VALID_RUN_ON.has(entry)) {
        diagnostics.push("storage.lifecycle.runOn entries must be one of run, open, or runs.");
        break;
      }
    }
  }

  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    diagnostics.push("storage.lifecycle.enabled must be a boolean when present.");
  }
  if (
    value.throttle !== undefined &&
    value.throttle !== false &&
    typeof value.throttle !== "string"
  ) {
    diagnostics.push("storage.lifecycle.throttle must be a string or false when present.");
  }

  const retention = parseRetentionConfig("storage.lifecycle", value, diagnostics);
  const workflows = parseWorkflowRetentionConfigs(value.workflows, diagnostics);

  return {
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(runOn === undefined ? {} : { runOn: runOn as readonly ("run" | "open" | "runs")[] }),
    ...(value.throttle === undefined ||
    (value.throttle !== false && typeof value.throttle !== "string")
      ? {}
      : { throttle: value.throttle }),
    ...(retention === undefined ? {} : retention),
    ...(workflows === undefined ? {} : { workflows }),
  };
}

function parseWorkflowRetentionConfigs(
  value: unknown,
  diagnostics: string[],
): NonNullable<NonNullable<TrailStepStorageConfig["lifecycle"]>["workflows"]> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push("storage.lifecycle.workflows must be an object when present.");
    return undefined;
  }

  const workflows: Record<
    string,
    NonNullable<NonNullable<TrailStepStorageConfig["lifecycle"]>["workflows"]>[string]
  > = {};
  for (const [workflowId, config] of Object.entries(value)) {
    const parsed = parseRetentionConfig(
      `storage.lifecycle.workflows.${workflowId}`,
      config,
      diagnostics,
    );
    if (parsed !== undefined) {
      workflows[workflowId] = parsed;
    }
  }
  return workflows;
}

function parseRetentionConfig(
  path: string,
  value: unknown,
  diagnostics: string[],
): NonNullable<NonNullable<TrailStepStorageConfig["lifecycle"]>["workflows"]>[string] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return undefined;
  }

  validateDurationOrFalse(`${path}.compressAfter`, value.compressAfter, diagnostics);
  validateDurationOrFalse(`${path}.deleteAfter`, value.deleteAfter, diagnostics);

  return {
    ...(value.compressAfter === undefined ||
    (value.compressAfter !== false && typeof value.compressAfter !== "string")
      ? {}
      : { compressAfter: value.compressAfter }),
    ...(value.deleteAfter === undefined ||
    (value.deleteAfter !== false && typeof value.deleteAfter !== "string")
      ? {}
      : { deleteAfter: value.deleteAfter }),
  };
}

function validateDurationOrFalse(path: string, value: unknown, diagnostics: string[]): void {
  if (value === undefined || value === false) {
    return;
  }
  if (typeof value === "string" && parseStorageLifecycleDurationDays(value) !== undefined) {
    return;
  }
  diagnostics.push(
    `${path} must be a duration string (for example 7d, 12h, or 2w) or false when present.`,
  );
}
