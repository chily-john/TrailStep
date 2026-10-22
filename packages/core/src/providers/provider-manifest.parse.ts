import {
  parseOptionalStringArray,
  throwValidationFailure,
} from "../agent-targeting/parse-trailstep-config/parse-utils.js";
import type { WorkflowAgentThinking } from "../contracts/agents/agent-role.types.js";
import { isRecord } from "../json/guards.js";
import {
  parseOptionalNonEmptyString,
  parseRequiredString,
  parseRequiredStringArray,
  parseSupportedObject,
  THINKING_LEVELS,
} from "./provider-manifest.parse-utils.js";
import type {
  TrailStepProviderEnvironmentManifest,
  TrailStepProviderFollowUpManifest,
  TrailStepProviderHygieneCapability,
  TrailStepProviderHygieneManifest,
  TrailStepProviderInteractiveManifest,
  TrailStepProviderManifest,
  TrailStepProviderModelDiscoveryManifest,
  TrailStepProviderModelManifest,
  TrailStepProviderOutputManifest,
  TrailStepProviderOutputParsingManifest,
  TrailStepProviderOutputStyle,
  TrailStepProviderPromptManifest,
  TrailStepProviderThinkingManifest,
  TrailStepProviderWorkingManifest,
} from "./provider-manifest.types.js";

export function parseTrailStepProviderManifest(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest | undefined {
  return parseManifest(path, value, diagnostics);
}

export function parseProviderManifest(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest | undefined {
  return parseManifest(path, value, diagnostics);
}

export function throwIfNewDiagnostics(diagnostics: string[], start: number): void {
  if (diagnostics.length > start) {
    throwValidationFailure(diagnostics);
  }
}

function parseManifest(
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
  const interactive = parseInteractive(`${path}.interactive`, value.interactive, diagnostics);
  const model = parseModel(`${path}.model`, value.model, diagnostics);
  const thinking = parseThinking(`${path}.thinking`, value.thinking, diagnostics);
  const env = parseEnvironment(`${path}.env`, value.env, diagnostics);
  const hygiene = parseHygiene(`${path}.hygiene`, value.hygiene, diagnostics);

  if (
    value.schemaVersion !== 1 ||
    id === undefined ||
    displayName === undefined ||
    working === undefined ||
    interactive === undefined ||
    model === undefined ||
    thinking === undefined ||
    env === null ||
    hygiene === null
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
    ...(env === undefined ? {} : { env }),
    ...(hygiene === undefined ? {} : { hygiene }),
    ...(isRecord(value.hooks) ? { hooks: value.hooks } : {}),
  };
}

export function parseWorking(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderWorkingManifest | undefined {
  if (!isRecord(value) || typeof value.supported !== "boolean") {
    diagnostics.push(`${path} must be an object with a boolean supported field.`);
    return undefined;
  }

  if (!value.supported) {
    return { supported: false };
  }

  const command = parseRequiredString(`${path}.command`, value.command, diagnostics);
  const args = parseOptionalStringArray(`${path}.args`, value.args, diagnostics);
  const prompt = parsePrompt(`${path}.prompt`, value.prompt, diagnostics);
  const output = parseOutput(`${path}.output`, value.output, diagnostics);
  const followUp = parseFollowUp(`${path}.followUp`, value.followUp, diagnostics);

  if (command === undefined || prompt === undefined || output === undefined || followUp === null) {
    return undefined;
  }

  return {
    supported: true,
    command,
    ...(args === undefined ? {} : { args }),
    prompt,
    output,
    ...(followUp === undefined ? {} : { followUp }),
  };
}

function parseFollowUp(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderFollowUpManifest | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || typeof value.supported !== "boolean") {
    diagnostics.push(`${path} must be an object with a boolean supported field.`);
    return null;
  }
  if (!value.supported) {
    return {
      supported: false,
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    };
  }
  const sessionIdFlag = parseOptionalNonEmptyString(
    `${path}.sessionIdFlag`,
    value.sessionIdFlag,
    diagnostics,
  );
  if (sessionIdFlag === null) {
    return null;
  }
  let resumeArgs: readonly string[] | undefined;
  if (value.resumeArgs !== undefined) {
    if (
      !Array.isArray(value.resumeArgs) ||
      value.resumeArgs.some((item) => typeof item !== "string")
    ) {
      diagnostics.push(`${path}.resumeArgs must be an array of strings when present.`);
      return null;
    }
    resumeArgs = value.resumeArgs;
  }
  return {
    supported: true,
    ...(sessionIdFlag === undefined ? {} : { sessionIdFlag }),
    ...(resumeArgs === undefined ? {} : { resumeArgs }),
  };
}

function parseInteractive(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderInteractiveManifest | undefined {
  const parsed = parseSupportedObject(path, value, diagnostics);
  if (parsed === undefined || !isRecord(value)) {
    return undefined;
  }
  const command = parseOptionalNonEmptyString(`${path}.command`, value.command, diagnostics);
  const args = parseOptionalStringArray(`${path}.args`, value.args, diagnostics);
  const systemPromptFileFlag = parseOptionalNonEmptyString(
    `${path}.systemPromptFileFlag`,
    value.systemPromptFileFlag,
    diagnostics,
  );
  const modelFlag = parseOptionalNonEmptyString(`${path}.modelFlag`, value.modelFlag, diagnostics);
  const permissionBypassFlag = parseOptionalNonEmptyString(
    `${path}.permissionBypassFlag`,
    value.permissionBypassFlag,
    diagnostics,
  );
  if (
    command === null ||
    systemPromptFileFlag === null ||
    modelFlag === null ||
    permissionBypassFlag === null
  ) {
    return undefined;
  }
  return {
    ...parsed,
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(typeof value.requiresSystemPromptFile === "boolean"
      ? { requiresSystemPromptFile: value.requiresSystemPromptFile }
      : {}),
    ...(systemPromptFileFlag === undefined ? {} : { systemPromptFileFlag }),
    ...(modelFlag === undefined ? {} : { modelFlag }),
    ...(permissionBypassFlag === undefined ? {} : { permissionBypassFlag }),
  };
}

function parseEnvironment(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderEnvironmentManifest | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return null;
  }
  const start = diagnostics.length;
  const required = parseOptionalStringArray(`${path}.required`, value.required, diagnostics);
  const optional = parseOptionalStringArray(`${path}.optional`, value.optional, diagnostics);
  if (diagnostics.length > start) {
    return null;
  }
  return {
    ...(required === undefined ? {} : { required }),
    ...(optional === undefined ? {} : { optional }),
  };
}

function parseHygiene(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderHygieneManifest | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return null;
  }

  // Unknown hygiene keys are intentionally ignored so newer provider
  // packages stay loadable by older TrailStep versions (back-compat).
  const tools = parseHygieneCapability(`${path}.tools`, value.tools, diagnostics);
  const skills = parseHygieneCapability(`${path}.skills`, value.skills, diagnostics);
  const mcp = parseHygieneCapability(`${path}.mcp`, value.mcp, diagnostics);
  const extensions = parseHygieneCapability(`${path}.extensions`, value.extensions, diagnostics);
  // `contextSuppression` is the provider-package spelling of `contextFiles`.
  const contextFiles =
    value.contextFiles === undefined
      ? parseHygieneCapability(`${path}.contextSuppression`, value.contextSuppression, diagnostics)
      : parseHygieneCapability(`${path}.contextFiles`, value.contextFiles, diagnostics);

  if (
    tools === null ||
    skills === null ||
    mcp === null ||
    extensions === null ||
    contextFiles === null
  ) {
    return null;
  }

  return {
    ...(tools === undefined ? {} : { tools }),
    ...(skills === undefined ? {} : { skills }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(extensions === undefined ? {} : { extensions }),
    ...(contextFiles === undefined ? {} : { contextFiles }),
  };
}

function parseHygieneCapability(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderHygieneCapability | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return null;
  }

  const start = diagnostics.length;
  let supported = true;
  if (value.supported !== undefined) {
    if (typeof value.supported !== "boolean") {
      diagnostics.push(`${path}.supported must be a boolean when present.`);
    } else {
      supported = value.supported;
    }
  }

  const flag = parseOptionalNonEmptyString(`${path}.flag`, value.flag, diagnostics);
  const disableFlag = parseOptionalNonEmptyString(
    `${path}.disableFlag`,
    value.disableFlag,
    diagnostics,
  );
  const enableFlag = parseOptionalNonEmptyString(
    `${path}.enableFlag`,
    value.enableFlag,
    diagnostics,
  );
  const reason = parseOptionalNonEmptyString(`${path}.reason`, value.reason, diagnostics);

  if (
    diagnostics.length > start ||
    flag === null ||
    disableFlag === null ||
    enableFlag === null ||
    reason === null
  ) {
    return null;
  }

  let invalid = false;
  if (!supported) {
    if (reason === undefined) {
      diagnostics.push(`${path} must declare reason when supported is false.`);
      invalid = true;
    }
  } else if (flag === undefined && disableFlag === undefined) {
    diagnostics.push(`${path} must declare flag or disableFlag when present.`);
    invalid = true;
  }

  if (invalid) {
    return null;
  }

  return {
    ...(supported ? {} : { supported }),
    ...(flag === undefined ? {} : { flag }),
    ...(disableFlag === undefined ? {} : { disableFlag }),
    ...(enableFlag === undefined ? {} : { enableFlag }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function parseModel(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderModelManifest | undefined {
  const parsed = parseSupportedObject(path, value, diagnostics);
  if (parsed === undefined || !isRecord(value)) {
    return undefined;
  }
  const flag = parseOptionalNonEmptyString(`${path}.flag`, value.flag, diagnostics);
  const discovery = parseModelDiscovery(`${path}.discovery`, value.discovery, diagnostics);
  if (flag === null || discovery === null) {
    return undefined;
  }
  return {
    ...parsed,
    ...(flag === undefined ? {} : { flag }),
    ...(discovery === undefined ? {} : { discovery }),
  };
}

function parseModelDiscovery(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderModelDiscoveryManifest | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return null;
  }
  const command = parseRequiredString(`${path}.command`, value.command, diagnostics);
  const args = parseRequiredStringArray(`${path}.args`, value.args, diagnostics);
  const outputParser = parseRequiredString(`${path}.outputParser`, value.outputParser, diagnostics);
  if (command === undefined || args === undefined || outputParser === undefined) {
    return null;
  }
  return { command, args, outputParser };
}

function parseThinking(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderThinkingManifest | undefined {
  const parsed = parseSupportedObject(path, value, diagnostics);
  if (parsed === undefined || !isRecord(value)) {
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
      ...parsed,
      ...(flag === undefined ? {} : { flag }),
      levels: value.levels as WorkflowAgentThinking[],
    };
  }

  return { ...parsed, ...(flag === undefined ? {} : { flag }) };
}

function parsePrompt(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderPromptManifest | undefined {
  if (!isRecord(value) || value.kind !== "prompt-file") {
    diagnostics.push(`${path}.kind must be prompt-file.`);
    return undefined;
  }
  if (value.reference !== undefined && value.reference !== "at-prefixed-argument") {
    diagnostics.push(`${path}.reference must be at-prefixed-argument when present.`);
    return undefined;
  }
  return {
    kind: "prompt-file",
    ...(value.reference === undefined ? {} : { reference: value.reference }),
  };
}

function parseOutput(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderOutputManifest | undefined {
  if (!isRecord(value) || !isProviderOutputStyle(value.style)) {
    diagnostics.push(
      `${path}.style must be provider-output-file, stdout-json-envelope, or stdout-jsonl-transcript.`,
    );
    return undefined;
  }
  const parsing = parseOutputParsing(`${path}.parsing`, value.parsing, diagnostics);
  if (parsing === null) {
    return undefined;
  }
  return {
    style: value.style,
    ...(parsing === undefined ? {} : { parsing }),
  };
}

function parseOutputParsing(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderOutputParsingManifest | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return null;
  }
  const resultField = parseOptionalNonEmptyString(
    `${path}.resultField`,
    value.resultField,
    diagnostics,
  );
  if (resultField === null) {
    return null;
  }
  return {
    ...(resultField === undefined ? {} : { resultField }),
  };
}

function isProviderOutputStyle(value: unknown): value is TrailStepProviderOutputStyle {
  return (
    value === "provider-output-file" ||
    value === "stdout-json-envelope" ||
    value === "stdout-jsonl-transcript"
  );
}
