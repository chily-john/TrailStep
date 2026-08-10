import {
  isParsedTrailStepConfig,
  parseTrailStepConfig,
} from "../../agent-targeting/parse-trailstep-config/parse-trailstep-config.js";
import type { TrailStepConfig } from "../../agent-targeting/targeting.types.js";
import type { RunWorkflowOptions } from "./run-workflow.types.js";

export function parseTrailStepConfigInput(
  value: RunWorkflowOptions["trailstepConfig"],
): TrailStepConfig {
  if (isParsedTrailStepConfig(value) || isFlattenedTrailStepConfig(value)) {
    return value;
  }

  return parseTrailStepConfig(value);
}

function isFlattenedTrailStepConfig(
  value: RunWorkflowOptions["trailstepConfig"],
): value is TrailStepConfig {
  if (!isPlainRecord(value) || value.version !== 1) {
    return false;
  }

  if (!isPlainRecord(value.customProviders) || !isFlattenedAgentMappings(value.agents)) {
    return false;
  }

  if (value.settings !== undefined && !isFlattenedSettings(value.settings)) {
    return false;
  }

  if (value.workflows === undefined) {
    return true;
  }

  if (!isPlainRecord(value.workflows)) {
    return false;
  }

  return Object.values(value.workflows).every(
    (workflow) =>
      isPlainRecord(workflow) &&
      (workflow.agents === undefined || isFlattenedAgentMappings(workflow.agents)) &&
      (workflow.settings === undefined || isFlattenedSettings(workflow.settings)),
  );
}

function isFlattenedSettings(value: unknown): value is NonNullable<TrailStepConfig["settings"]> {
  return (
    isPlainRecord(value) &&
    (value.retry === undefined || isPlainRecord(value.retry)) &&
    (value.timeout === undefined || typeof value.timeout === "number")
  );
}

function isFlattenedAgentMappings(value: unknown): value is TrailStepConfig["agents"] {
  return (
    isPlainRecord(value) &&
    Object.values(value).every(
      (targets) => Array.isArray(targets) && targets.every(isFlattenedAgentTarget),
    )
  );
}

function isFlattenedAgentTarget(
  value: unknown,
): value is TrailStepConfig["agents"][string][number] {
  return isPlainRecord(value) && typeof value.provider === "string";
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
