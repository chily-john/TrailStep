import type { StepKitCustomProviderConfig } from "../targeting.types.js";
import { isRecord, parseOptionalStringArray, parseOptionalStringRecord } from "./parse-utils.js";

export function parseCustomProviders(
  value: unknown,
  diagnostics: string[],
): Record<string, StepKitCustomProviderConfig> {
  const customProviders: Record<string, StepKitCustomProviderConfig> = {};

  if (!isRecord(value)) {
    diagnostics.push("customProviders must be an object.");
    return customProviders;
  }

  for (const [name, providerConfig] of Object.entries(value)) {
    if (!isRecord(providerConfig)) {
      diagnostics.push(`customProviders.${name} must be an object.`);
      continue;
    }

    if (typeof providerConfig.binary !== "string" || providerConfig.binary.length === 0) {
      diagnostics.push(`customProviders.${name}.binary must be a non-empty string.`);
      continue;
    }

    const args = parseOptionalStringArray(
      `customProviders.${name}.args`,
      providerConfig.args,
      diagnostics,
    );
    const interactiveArgs = parseOptionalStringArray(
      `customProviders.${name}.interactiveArgs`,
      providerConfig.interactiveArgs,
      diagnostics,
    );
    const env = parseOptionalStringRecord(
      `customProviders.${name}.env`,
      providerConfig.env,
      diagnostics,
    );

    if (providerConfig.cwd !== undefined && typeof providerConfig.cwd !== "string") {
      diagnostics.push(`customProviders.${name}.cwd must be a string when present.`);
    }

    customProviders[name] = {
      binary: providerConfig.binary,
      ...(args === undefined ? {} : { args }),
      ...(interactiveArgs === undefined ? {} : { interactiveArgs }),
      ...(typeof providerConfig.cwd === "string" ? { cwd: providerConfig.cwd } : {}),
      ...(env === undefined ? {} : { env }),
    };
  }

  return customProviders;
}
