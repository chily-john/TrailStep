import { isRecord } from "../json/guards.js";
import { parseLegacyProviderManifest } from "./provider-manifest.legacy.js";
import { parseProviderManifest, throwIfNewDiagnostics } from "./provider-manifest.parse.js";
import type { TrailStepProviderRegistration } from "./provider-manifest.types.js";

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
      ? parseLegacyProviderManifest(`${path}.manifest`, value.manifest, diagnostics)
      : parseProviderManifest(`${path}.manifest`, value.manifest, diagnostics);

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
