import {
  parseOptionalStringArray,
  parseOptionalStringRecord,
} from "../agent-targeting/parse-trailstep-config/parse-utils.js";
import type { WorkflowAgentThinking } from "../contracts/agents/agent-role.types.js";
import { isRecord } from "../json/guards.js";
import { parseWorking } from "./provider-manifest.parse.js";
import {
  parseOptionalNonEmptyString,
  parseRequiredString,
  parseSupportedObject,
  THINKING_LEVELS,
} from "./provider-manifest.parse-utils.js";
import type { TrailStepProviderManifest } from "./provider-manifest.types.js";

/**
 * Legacy custom-provider manifest shape: the pre-1.0 manifest fields that
 * are still accepted for `legacy-custom-provider` registrations.
 */
export function parseLegacyProviderManifest(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest | undefined {
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return undefined;
  }

  if (value.schemaVersion !== 1) {
    diagnostics.push(`${path}.schemaVersion must be 1.`);
  }
  const id = parseRequiredString(`${path}.id`, value.id, diagnostics);
  const displayName = parseRequiredString(`${path}.displayName`, value.displayName, diagnostics);
  const working = parseWorking(`${path}.working`, value.working, diagnostics);
  const interactive = parseLegacyInteractive(`${path}.interactive`, value.interactive, diagnostics);
  const model = parseLegacyModel(`${path}.model`, value.model, diagnostics);
  const thinking = parseLegacyThinking(`${path}.thinking`, value.thinking, diagnostics);
  const env = parseOptionalStringRecord(`${path}.env`, value.env, diagnostics);

  if (
    value.schemaVersion !== 1 ||
    id === undefined ||
    displayName === undefined ||
    working === undefined ||
    interactive === undefined ||
    model === undefined ||
    thinking === undefined
  ) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    id,
    displayName,
    working,
    interactive,
    model,
    thinking,
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(env === undefined ? {} : { env }),
  } as TrailStepProviderManifest;
}

function parseLegacyInteractive(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest["interactive"] | undefined {
  const parsed = parseSupportedObject(path, value, diagnostics);
  if (parsed === undefined || !isRecord(value)) {
    return undefined;
  }
  const command = parseOptionalNonEmptyString(`${path}.command`, value.command, diagnostics);
  const args = parseOptionalStringArray(`${path}.args`, value.args, diagnostics);
  if (command === null) {
    return undefined;
  }
  return {
    ...parsed,
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
  } as TrailStepProviderManifest["interactive"];
}

function parseLegacyModel(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest["model"] | undefined {
  const parsed = parseSupportedObject(path, value, diagnostics);
  if (parsed === undefined || !isRecord(value)) {
    return undefined;
  }
  const flag = parseOptionalNonEmptyString(`${path}.flag`, value.flag, diagnostics);
  if (flag === null) {
    return undefined;
  }
  return {
    ...parsed,
    ...(flag === undefined ? {} : { flag }),
  } as TrailStepProviderManifest["model"];
}

function parseLegacyThinking(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest["thinking"] | undefined {
  if (!isRecord(value) || typeof value.supported !== "boolean") {
    diagnostics.push(`${path} must be an object with a boolean supported field.`);
    return undefined;
  }

  const flag = parseOptionalNonEmptyString(`${path}.flag`, value.flag, diagnostics);
  if (flag === null) {
    return undefined;
  }

  if (value.levels !== undefined) {
    if (
      !Array.isArray(value.levels) ||
      value.levels.some(
        (level) =>
          typeof level !== "string" || !THINKING_LEVELS.has(level as WorkflowAgentThinking),
      )
    ) {
      diagnostics.push(
        `${path}.levels must be an array of supported thinking levels when present.`,
      );
      return undefined;
    }
    return {
      supported: value.supported,
      ...(flag === undefined ? {} : { flag }),
      levels: value.levels as WorkflowAgentThinking[],
    } as TrailStepProviderManifest["thinking"];
  }

  return {
    supported: value.supported,
    ...(flag === undefined ? {} : { flag }),
  } as TrailStepProviderManifest["thinking"];
}
