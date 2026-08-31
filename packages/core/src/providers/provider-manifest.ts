import {
  isRecord,
  parseOptionalStringArray,
  throwValidationFailure,
} from "../agent-targeting/parse-trailstep-config/parse-utils.js";
import type { WorkflowAgentThinking } from "../contracts/agents/agent-role.types.js";

export interface TrailStepProviderRegistration {
  readonly source: {
    readonly type: "local-manifest";
    readonly path: string;
  };
  readonly manifest: TrailStepProviderManifest;
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
}

export interface TrailStepProviderWorkingManifest {
  readonly supported: boolean;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly prompt?: { readonly kind: "prompt-file" };
  readonly output?: { readonly style: "provider-output-file" };
}

export interface TrailStepProviderInteractiveManifest {
  readonly supported: boolean;
  readonly reason?: string;
  readonly command?: string;
}

export interface TrailStepProviderEnvironmentManifest {
  readonly required?: readonly string[];
  readonly optional?: readonly string[];
}

export interface TrailStepProviderModelManifest {
  readonly supported: boolean;
}

export interface TrailStepProviderThinkingManifest {
  readonly supported: boolean;
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
  const manifest = parseManifest(`${path}.manifest`, value.manifest, diagnostics);

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

  if (value.type !== "local-manifest") {
    diagnostics.push(`${path}.type must be local-manifest.`);
  }

  if (typeof value.path !== "string" || value.path.length === 0) {
    diagnostics.push(`${path}.path must be a non-empty string.`);
  }

  if (
    value.type !== "local-manifest" ||
    typeof value.path !== "string" ||
    value.path.length === 0
  ) {
    return undefined;
  }

  return { type: "local-manifest", path: value.path };
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
  const model = parseSupportedObject(`${path}.model`, value.model, diagnostics);
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
  if (command === null) {
    return undefined;
  }
  return { ...parsed, ...(command === undefined ? {} : { command }) };
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

function parseThinking(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderThinkingManifest | undefined {
  if (!isRecord(value) || typeof value.supported !== "boolean") {
    diagnostics.push(`${path} must be an object with a boolean supported field.`);
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
    return { supported: value.supported, levels: value.levels as WorkflowAgentThinking[] };
  }

  return { supported: value.supported };
}

function parsePrompt(
  path: string,
  value: unknown,
  diagnostics: string[],
): { readonly kind: "prompt-file" } | undefined {
  if (!isRecord(value) || value.kind !== "prompt-file") {
    diagnostics.push(`${path}.kind must be prompt-file.`);
    return undefined;
  }
  return { kind: "prompt-file" };
}

function parseOutput(
  path: string,
  value: unknown,
  diagnostics: string[],
): { readonly style: "provider-output-file" } | undefined {
  if (!isRecord(value) || value.style !== "provider-output-file") {
    diagnostics.push(`${path}.style must be provider-output-file.`);
    return undefined;
  }
  return { style: "provider-output-file" };
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
