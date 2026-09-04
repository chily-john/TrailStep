import {
  isRecord,
  parseOptionalStringArray,
  parseOptionalStringRecord,
  throwValidationFailure,
} from "../agent-targeting/parse-trailstep-config/parse-utils.js";
import type { WorkflowAgentThinking } from "../contracts/agents/agent-role.types.js";

export interface TrailStepProviderRegistration {
  readonly source: TrailStepProviderSource;
  readonly manifest: TrailStepProviderManifest;
}

export type TrailStepProviderSource =
  | { readonly type: "local-manifest"; readonly path: string }
  | { readonly type: "legacy-custom-provider" }
  | {
      readonly type: "npm" | "github" | "local-package";
      readonly packageName: string;
      readonly spec: string;
      readonly resolvedVersion?: string;
    };

/**
 * ESM package contract for provider packages: export `trailstepProvider` from
 * the package root. Keep hook functions outside `manifest` so the manifest is
 * serializable and safe to persist.
 */
export interface TrailStepProviderPackageDefinition {
  readonly manifest: TrailStepProviderManifest;
  readonly hooks?: Record<string, unknown>;
}

export interface TrailStepProviderManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly working: TrailStepProviderWorkingManifest;
  readonly interactive: TrailStepProviderInteractiveManifest;
  readonly model: TrailStepProviderModelManifest;
  readonly thinking: TrailStepProviderThinkingManifest;
  readonly env?: TrailStepProviderEnvironmentManifest;
  readonly hooks?: Record<string, unknown>;
}

export type TrailStepProviderPromptFileReferenceStyle = "at-prefixed-argument";

export interface TrailStepProviderPromptManifest {
  readonly kind: "prompt-file";
  readonly reference?: TrailStepProviderPromptFileReferenceStyle;
}

export type TrailStepProviderOutputStyle =
  | "provider-output-file"
  | "stdout-json-envelope"
  | "stdout-jsonl-transcript";

export interface TrailStepProviderOutputParsingManifest {
  readonly resultField?: string;
}

export interface TrailStepProviderOutputManifest {
  readonly style: TrailStepProviderOutputStyle;
  readonly parsing?: TrailStepProviderOutputParsingManifest;
}

export interface TrailStepProviderWorkingManifest {
  readonly supported: boolean;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly prompt?: TrailStepProviderPromptManifest;
  readonly output?: TrailStepProviderOutputManifest;
}

export interface TrailStepProviderInteractiveManifest {
  readonly supported: boolean;
  readonly reason?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly requiresSystemPromptFile?: boolean;
  readonly systemPromptFileFlag?: string;
  readonly modelFlag?: string;
  readonly permissionBypassFlag?: string;
}

export interface TrailStepProviderEnvironmentManifest {
  readonly required?: readonly string[];
  readonly optional?: readonly string[];
}

export interface TrailStepProviderModelDiscoveryManifest {
  readonly command: string;
  readonly args: readonly string[];
  readonly outputParser: string;
}

export interface TrailStepProviderModelManifest {
  readonly supported: boolean;
  readonly reason?: string;
  readonly flag?: string;
  readonly discovery?: TrailStepProviderModelDiscoveryManifest;
}

export interface TrailStepProviderThinkingManifest {
  readonly supported: boolean;
  readonly reason?: string;
  readonly flag?: string;
  readonly levels?: readonly WorkflowAgentThinking[];
}

const THINKING_LEVELS = new Set<WorkflowAgentThinking>(["low", "medium", "high", "xhigh", "max"]);

export function parseTrailStepProviderManifest(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest | undefined {
  return parseManifest(path, value, diagnostics);
}

export function parseTrailStepProviderRegistrations(
  path: string,
  value: unknown,
  diagnostics: string[],
): Record<string, TrailStepProviderRegistration> {
  const start = diagnostics.length;
  const providers: Record<string, TrailStepProviderRegistration> = {};

  if (value === undefined) {
    return providers;
  }

  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    throwIfNewDiagnostics(diagnostics, start);
    return providers;
  }

  for (const [name, registration] of Object.entries(value)) {
    const parsed = parseProviderRegistration(`${path}.${name}`, registration, diagnostics);
    if (parsed !== undefined) {
      providers[name] = parsed;
    }
  }

  throwIfNewDiagnostics(diagnostics, start);
  return providers;
}

function parseProviderRegistration(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderRegistration | undefined {
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return undefined;
  }

  const source = parseSource(`${path}.source`, value.source, diagnostics);
  const manifest =
    source?.type === "legacy-custom-provider"
      ? parseLegacyCustomProviderManifest(`${path}.manifest`, value.manifest, diagnostics)
      : parseManifest(`${path}.manifest`, value.manifest, diagnostics);

  if (source === undefined || manifest === undefined) {
    return undefined;
  }

  return { source, manifest };
}

function parseSource(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderRegistration["source"] | undefined {
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return undefined;
  }

  if (value.type === "local-manifest") {
    if (typeof value.path !== "string" || value.path.length === 0) {
      diagnostics.push(`${path}.path must be a non-empty string.`);
      return undefined;
    }
    return { type: "local-manifest", path: value.path };
  }

  if (value.type === "legacy-custom-provider") {
    return { type: "legacy-custom-provider" };
  }

  if (value.type === "npm" || value.type === "github" || value.type === "local-package") {
    if (typeof value.packageName !== "string" || value.packageName.length === 0) {
      diagnostics.push(`${path}.packageName must be a non-empty string.`);
    }
    if (typeof value.spec !== "string" || value.spec.length === 0) {
      diagnostics.push(`${path}.spec must be a non-empty string.`);
    }
    if (
      typeof value.packageName !== "string" ||
      value.packageName.length === 0 ||
      typeof value.spec !== "string" ||
      value.spec.length === 0
    ) {
      return undefined;
    }
    return {
      type: value.type,
      packageName: value.packageName,
      spec: value.spec,
      ...(typeof value.resolvedVersion === "string" && value.resolvedVersion.length > 0
        ? { resolvedVersion: value.resolvedVersion }
        : {}),
    };
  }

  diagnostics.push(
    `${path}.type must be local-manifest, legacy-custom-provider, npm, github, or local-package.`,
  );
  return undefined;
}

function parseLegacyCustomProviderManifest(
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

  if (
    value.schemaVersion !== 1 ||
    id === undefined ||
    displayName === undefined ||
    working === undefined ||
    interactive === undefined ||
    model === undefined ||
    thinking === undefined ||
    env === null
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
    ...(isRecord(value.hooks) ? { hooks: value.hooks } : {}),
  };
}

function parseWorking(
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

  if (command === undefined || prompt === undefined || output === undefined) {
    return undefined;
  }

  return { supported: true, command, ...(args === undefined ? {} : { args }), prompt, output };
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

function parseSupportedObject(
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

function parseRequiredString(
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

function parseRequiredStringArray(
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

function parseOptionalNonEmptyString(
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

function throwIfNewDiagnostics(diagnostics: string[], start: number): void {
  if (diagnostics.length > start) {
    throwValidationFailure(diagnostics);
  }
}
