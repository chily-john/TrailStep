import { isAbsolute } from "node:path";

export interface ParsedNpmPackageRef {
  readonly sourceType: "npm";
  readonly packageName: string;
  readonly requestedSpec: string;
  readonly requestedRange: string;
}

export function parseNpmPackageRef(source: string): ParsedNpmPackageRef | undefined {
  if (isLocalOrBundleRef(source)) {
    return undefined;
  }

  const parsed = source.startsWith("@")
    ? parseScopedNpmPackageRef(source)
    : parseUnscopedNpmPackageRef(source);
  if (parsed === undefined || parsed.requestedRange.trim().length === 0) {
    return undefined;
  }

  return parsed;
}

function parseScopedNpmPackageRef(source: string): ParsedNpmPackageRef | undefined {
  const match = /^(?<packageName>@[^/@\\\s]+\/[^/@\\\s]+)@(?<requestedRange>.+)$/u.exec(source);
  const packageName = match?.groups?.packageName;
  const requestedRange = match?.groups?.requestedRange;
  if (packageName === undefined || requestedRange === undefined) {
    return undefined;
  }
  return {
    sourceType: "npm",
    packageName,
    requestedSpec: source,
    requestedRange,
  };
}

function parseUnscopedNpmPackageRef(source: string): ParsedNpmPackageRef | undefined {
  const match = /^(?<packageName>[^/@\\\s][^/@\\\s]*)@(?<requestedRange>.+)$/u.exec(source);
  const packageName = match?.groups?.packageName;
  const requestedRange = match?.groups?.requestedRange;
  if (packageName === undefined || requestedRange === undefined) {
    return undefined;
  }
  return {
    sourceType: "npm",
    packageName,
    requestedSpec: source,
    requestedRange,
  };
}

function isLocalOrBundleRef(source: string): boolean {
  return (
    source.includes("#") ||
    source.includes(":") ||
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.startsWith(".\\") ||
    source.startsWith("..\\") ||
    isAbsolute(source) ||
    /^[A-Za-z]:[\\/]/u.test(source) ||
    source.startsWith("\\\\")
  );
}
