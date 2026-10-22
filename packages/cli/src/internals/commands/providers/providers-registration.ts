import type { TrailStepProviderManifest } from "@trailstep/core";

import type {
  ProviderManifestWithStoredMetadata,
  TrailStepProviderRegistration,
} from "./providers-command.types.js";
import { parseLegacyProviderManifest, parseProviderManifest } from "./providers-manifest.js";
import { isRecord } from "./record-utils.js";

export function readRegistration(
  value: unknown,
  diagnostics: string[] = [],
): TrailStepProviderRegistration | undefined {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.manifest)) {
    diagnostics.push("registration must include source and manifest objects.");
    return undefined;
  }
  const source = readProviderSource(value.source, diagnostics);
  if (source === undefined) {
    return undefined;
  }
  const manifest =
    source.type === "legacy-custom-provider"
      ? parseLegacyProviderManifest("manifest", value.manifest, diagnostics)
      : parseProviderManifest("manifest", value.manifest, diagnostics);
  if (manifest === undefined || diagnostics.length > 0) {
    return undefined;
  }
  return {
    source,
    manifest: withStoredManifestMetadata(manifest, value.manifest),
  };
}

function readProviderSource(
  source: Record<string, unknown>,
  diagnostics: string[],
): TrailStepProviderRegistration["source"] | undefined {
  if (source.type === "local-manifest" && typeof source.path === "string") {
    return { type: "local-manifest", path: source.path };
  }
  if (source.type === "legacy-custom-provider") {
    return { type: "legacy-custom-provider" };
  }
  if (
    (source.type === "npm" || source.type === "github" || source.type === "local-package") &&
    typeof source.packageName === "string" &&
    typeof source.spec === "string"
  ) {
    return {
      type: source.type,
      packageName: source.packageName,
      spec: source.spec,
      ...(typeof source.resolvedVersion === "string"
        ? { resolvedVersion: source.resolvedVersion }
        : {}),
    };
  }
  diagnostics.push("registration.source must be a supported provider source.");
  return undefined;
}

export function formatProviderSource(source: TrailStepProviderRegistration["source"]): string {
  if (source.type === "local-manifest") {
    return `${source.type} ${source.path}`;
  }
  if (source.type === "legacy-custom-provider") {
    return source.type;
  }
  return `${source.type} ${source.packageName}`;
}

export function withStoredManifestMetadata(
  manifest: TrailStepProviderManifest,
  storedManifest: Record<string, unknown>,
): ProviderManifestWithStoredMetadata {
  const environment = parseEnvironmentDeclarations(storedManifest.environment);
  const env = parseEnvironmentDeclarations(storedManifest.env);
  const interactiveCommand = isRecord(storedManifest.interactive)
    ? parseOptionalString(storedManifest.interactive.command)
    : undefined;
  return {
    ...manifest,
    interactive: {
      ...manifest.interactive,
      ...(interactiveCommand === undefined ? {} : { command: interactiveCommand }),
    },
    ...(environment === undefined ? {} : { environment }),
    ...(env === undefined ? {} : { env }),
  };
}

export function requiredEnvironmentVariables(
  manifest: ProviderManifestWithStoredMetadata,
): readonly string[] {
  return [...(manifest.environment?.required ?? []), ...(manifest.env?.required ?? [])];
}

function parseEnvironmentDeclarations(
  value: unknown,
): { readonly required?: readonly string[]; readonly optional?: readonly string[] } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const required = parseStoredStringArray(value.required);
  const optional = parseStoredStringArray(value.optional);
  if (required === undefined && optional === undefined) {
    return undefined;
  }
  return {
    ...(required === undefined ? {} : { required }),
    ...(optional === undefined ? {} : { optional }),
  };
}

function parseStoredStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  return value;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
