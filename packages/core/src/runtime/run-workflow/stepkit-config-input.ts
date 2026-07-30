import {
  isParsedStepKitConfig,
  parseStepKitConfig,
} from "../../agent-targeting/parse-stepkit-config/parse-stepkit-config.js";
import type { StepKitConfig } from "../../agent-targeting/targeting.types.js";
import type { RunWorkflowOptions } from "./run-workflow.types.js";

export function parseStepKitConfigInput(value: RunWorkflowOptions["stepkitConfig"]): StepKitConfig {
  if (isParsedStepKitConfig(value) || isFlattenedStepKitConfig(value)) {
    return value;
  }

  return parseStepKitConfig(value);
}

function isFlattenedStepKitConfig(
  value: RunWorkflowOptions["stepkitConfig"],
): value is StepKitConfig {
  if (!isPlainRecord(value) || value.version !== 1) {
    return false;
  }

  if (!isPlainRecord(value.customProviders) || !isFlattenedAgentMappings(value.agents)) {
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
      (workflow.agents === undefined || isFlattenedAgentMappings(workflow.agents)),
  );
}

function isFlattenedAgentMappings(value: unknown): value is StepKitConfig["agents"] {
  return (
    isPlainRecord(value) &&
    Object.values(value).every(
      (targets) => Array.isArray(targets) && targets.every(isFlattenedAgentTarget),
    )
  );
}

function isFlattenedAgentTarget(value: unknown): value is StepKitConfig["agents"][string][number] {
  return isPlainRecord(value) && typeof value.provider === "string";
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
