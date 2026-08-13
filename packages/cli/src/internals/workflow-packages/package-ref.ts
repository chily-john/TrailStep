import { isAbsolute } from "node:path";

import { CliUsageError } from "../command.types.js";

export type ParsedWorkflowPackageRef = ParsedNpmPackageRef | ParsedGitHubPackageRef;

export interface ParsedNpmPackageRef {
  readonly sourceType: "npm";
  readonly packageName: string;
  readonly requestedSpec: string;
  readonly requestedRange: string;
}

export interface ParsedGitHubPackageRef {
  readonly sourceType: "github";
  readonly githubRef: string;
  readonly requestedSpec: string;
  readonly requestedRange: string;
}

export function parseWorkflowPackageRef(source: string): ParsedWorkflowPackageRef | undefined {
  const githubPackageRef = parseGitHubPackageRef(source);
  if (githubPackageRef !== undefined) {
    return githubPackageRef;
  }

  if (looksLikeUnsupportedGitHubShorthand(source)) {
    throw new CliUsageError(
      `Unsupported GitHub shorthand: ${source}. Use github:${source} for GitHub workflow packages.`,
    );
  }

  return parseNpmPackageRef(source);
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

function parseGitHubPackageRef(source: string): ParsedGitHubPackageRef | undefined {
  if (!source.startsWith("github:")) {
    return undefined;
  }

  const githubRef = source.slice("github:".length);
  if (!isSupportedGitHubRef(githubRef)) {
    throw new CliUsageError(
      "GitHub workflow package refs must use github:<owner>/<repo> with both parts present.",
    );
  }

  return {
    sourceType: "github",
    githubRef,
    requestedSpec: source,
    requestedRange: githubRef,
  };
}

function isSupportedGitHubRef(githubRef: string): boolean {
  return /^[^/@\\\s:]+\/[^/@\\\s:]+(?:#.+)?$/u.test(githubRef);
}

function looksLikeUnsupportedGitHubShorthand(source: string): boolean {
  return (
    !source.startsWith("@") &&
    !isLocalOrBundleRef(source) &&
    !lastPathSegmentLooksLikeFile(source) &&
    /^[^./\\\s][^/\\\s]*\/[^/\\\s]+$/u.test(source)
  );
}

function lastPathSegmentLooksLikeFile(source: string): boolean {
  const lastSeparatorIndex = Math.max(source.lastIndexOf("/"), source.lastIndexOf("\\"));
  const lastSegment = source.slice(lastSeparatorIndex + 1);
  return /^[^.].*\.[^.]+$/u.test(lastSegment);
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
