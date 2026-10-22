import type { TrailStepProviderManifest } from "@trailstep/core";
import * as trailstepCore from "@trailstep/core";

import { isRecord } from "./record-utils.js";

export function parseLegacyProviderManifest(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest | undefined {
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return undefined;
  }
  if (value.schemaVersion !== 1) diagnostics.push(`${path}.schemaVersion must be 1.`);
  const id = parseRequiredString(`${path}.id`, value.id, diagnostics);
  const displayName = parseRequiredString(`${path}.displayName`, value.displayName, diagnostics);
  const working = parseWorking(`${path}.working`, value.working, diagnostics);
  const interactive = parseLegacyInteractive(`${path}.interactive`, value.interactive, diagnostics);
  const model = parseLegacySupported(`${path}.model`, value.model, diagnostics);
  const thinking = parseLegacyThinking(`${path}.thinking`, value.thinking, diagnostics);
  const env = parseLegacyEnv(`${path}.env`, value.env, diagnostics);
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
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(env === undefined ? {} : { env }),
  } as TrailStepProviderManifest;
}

export function parseProviderManifest(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest | undefined {
  const parser = (
    trailstepCore as unknown as {
      readonly parseTrailStepProviderManifest?: (
        path: string,
        value: unknown,
        diagnostics: string[],
      ) => TrailStepProviderManifest | undefined;
    }
  ).parseTrailStepProviderManifest;
  if (parser !== undefined) {
    return parser(path, value, diagnostics);
  }
  return parseManifestSnapshot(path, value, diagnostics);
}

function parseManifestSnapshot(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest | undefined {
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return undefined;
  }
  if (value.schemaVersion !== 1) diagnostics.push(`${path}.schemaVersion must be 1.`);
  const id = parseRequiredString(`${path}.id`, value.id, diagnostics);
  const displayName = parseRequiredString(`${path}.displayName`, value.displayName, diagnostics);
  const working = parseWorking(`${path}.working`, value.working, diagnostics);
  const interactive = parseInteractive(`${path}.interactive`, value.interactive, diagnostics);
  const model = parseLegacySupported(`${path}.model`, value.model, diagnostics);
  const thinking = parseLegacyThinking(`${path}.thinking`, value.thinking, diagnostics);
  const env = parseManifestEnvironment(`${path}.env`, value.env, diagnostics);
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
): TrailStepProviderManifest["working"] | undefined {
  if (!isRecord(value) || typeof value.supported !== "boolean") {
    diagnostics.push(`${path} must be an object with a boolean supported field.`);
    return undefined;
  }
  if (!value.supported) return { supported: false };
  const command = parseRequiredString(`${path}.command`, value.command, diagnostics);
  const args = parseOptionalStringArray(`${path}.args`, value.args, diagnostics);
  const prompt = parsePromptSnapshot(`${path}.prompt`, value.prompt, diagnostics);
  const output = parseOutputSnapshot(`${path}.output`, value.output, diagnostics);
  if (command === undefined || args === null || prompt === undefined || output === undefined)
    return undefined;
  return { supported: true, command, ...(args === undefined ? {} : { args }), prompt, output };
}

function parsePromptSnapshot(
  path: string,
  value: unknown,
  diagnostics: string[],
): NonNullable<TrailStepProviderManifest["working"]["prompt"]> | undefined {
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

function parseOutputSnapshot(
  path: string,
  value: unknown,
  diagnostics: string[],
): NonNullable<TrailStepProviderManifest["working"]["output"]> | undefined {
  if (!isRecord(value) || !isProviderOutputStyle(value.style)) {
    diagnostics.push(
      `${path}.style must be provider-output-file, stdout-json-envelope, or stdout-jsonl-transcript.`,
    );
    return undefined;
  }
  const parsing = parseOutputParsingSnapshot(`${path}.parsing`, value.parsing, diagnostics);
  if (parsing === null) return undefined;
  return { style: value.style, ...(parsing === undefined ? {} : { parsing }) };
}

function parseOutputParsingSnapshot(
  path: string,
  value: unknown,
  diagnostics: string[],
):
  | NonNullable<NonNullable<TrailStepProviderManifest["working"]["output"]>["parsing"]>
  | undefined
  | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return null;
  }
  const resultField = parseOptionalNonEmptyString(
    `${path}.resultField`,
    value.resultField,
    diagnostics,
  );
  return resultField === null || resultField === undefined ? undefined : { resultField };
}

function isProviderOutputStyle(
  value: unknown,
): value is NonNullable<TrailStepProviderManifest["working"]["output"]>["style"] {
  return (
    value === "provider-output-file" ||
    value === "stdout-json-envelope" ||
    value === "stdout-jsonl-transcript"
  );
}

function parseLegacyInteractive(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest["interactive"] | undefined {
  const parsed = parseSupported(path, value, diagnostics);
  if (parsed === undefined || !isRecord(value)) return undefined;
  const command = parseOptionalNonEmptyString(`${path}.command`, value.command, diagnostics);
  const args = parseOptionalStringArray(`${path}.args`, value.args, diagnostics);
  if (command === null) return undefined;
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
): TrailStepProviderManifest["interactive"] | undefined {
  const parsed = parseSupported(path, value, diagnostics);
  if (parsed === undefined || !isRecord(value)) return undefined;
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
  )
    return undefined;
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
  } as TrailStepProviderManifest["interactive"];
}

function parseSupported(
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

function parseManifestEnvironment(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest["env"] | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return null;
  }
  const required = parseOptionalStringArray(`${path}.required`, value.required, diagnostics);
  const optional = parseOptionalStringArray(`${path}.optional`, value.optional, diagnostics);
  if (required === null || optional === null) return null;
  return {
    ...(required === undefined ? {} : { required }),
    ...(optional === undefined ? {} : { optional }),
  };
}

function parseLegacySupported(
  path: string,
  value: unknown,
  diagnostics: string[],
): TrailStepProviderManifest["model"] | undefined {
  const parsed = parseSupported(path, value, diagnostics);
  if (parsed === undefined || !isRecord(value)) return undefined;
  const flag = parseOptionalNonEmptyString(`${path}.flag`, value.flag, diagnostics);
  if (flag === null) return undefined;
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
  const parsed = parseSupported(path, value, diagnostics);
  if (parsed === undefined || !isRecord(value)) return undefined;
  const flag = parseOptionalNonEmptyString(`${path}.flag`, value.flag, diagnostics);
  if (flag === null) return undefined;
  if (value.levels !== undefined) {
    if (
      !Array.isArray(value.levels) ||
      value.levels.some(
        (level) =>
          typeof level !== "string" || !["low", "medium", "high", "xhigh", "max"].includes(level),
      )
    ) {
      diagnostics.push(
        `${path}.levels must be an array of supported thinking levels when present.`,
      );
      return undefined;
    }
    return {
      supported: parsed.supported,
      ...(flag === undefined ? {} : { flag }),
      levels: value.levels,
    } as TrailStepProviderManifest["thinking"];
  }
  return {
    ...parsed,
    ...(flag === undefined ? {} : { flag }),
  } as TrailStepProviderManifest["thinking"];
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

function parseLegacyEnv(
  path: string,
  value: unknown,
  diagnostics: string[],
): Readonly<Record<string, string>> | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return null;
  }
  const env: Record<string, string> = {};
  for (const [key, envValue] of Object.entries(value)) {
    if (typeof envValue !== "string") {
      diagnostics.push(`${path}.${key} must be a string.`);
    } else {
      env[key] = envValue;
    }
  }
  return env;
}

function parseOptionalStringArray(
  path: string,
  value: unknown,
  diagnostics: string[],
): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    diagnostics.push(`${path} must be an array of strings when present.`);
    return null;
  }
  return value;
}

export function parseOptionalNonEmptyString(
  path: string,
  value: unknown,
  diagnostics: string[],
): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    diagnostics.push(`${path} must be a non-empty string when present.`);
    return null;
  }
  return value;
}
