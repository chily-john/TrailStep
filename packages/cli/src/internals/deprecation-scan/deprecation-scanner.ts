import { readFile } from "node:fs/promises";
import {
  deprecationManifest as coreDeprecationManifest,
  type DeprecationManifest,
  type DeprecationTargetPackage,
  findDeprecationsAsOf,
} from "@trailstep/core";

import { extractTrailStepImportTokens } from "./import-specifier-tokens.js";

export type TrailStepDeprecationSeverity = "warning" | "blocking";
type TrailStepDeprecationSeverityState = "none" | TrailStepDeprecationSeverity;

export interface TrailStepDeprecationEntry {
  readonly packageName: string;
  readonly symbol: string;
  readonly deprecatedSince: string;
  readonly removedIn?: string;
  readonly message: string;
  readonly replacement?: string;
}

// Adapts @trailstep/core's manifest (field name "package") to this module's local shape (field name
// "packageName"). This is the real default used in production; tests override it via
// ScanWorkflowSourceOptions.manifest / CliCommandContext.deprecationManifest.
const defaultManifest: readonly TrailStepDeprecationEntry[] = coreDeprecationManifest.map(
  (entry) => ({
    packageName: entry.package,
    symbol: entry.symbol,
    deprecatedSince: entry.deprecatedSince,
    ...(entry.removedIn === undefined ? {} : { removedIn: entry.removedIn }),
    message: entry.message,
    ...(entry.replacement === undefined ? {} : { replacement: entry.replacement }),
  }),
);

export interface DeprecationFinding {
  readonly sourceFile: string;
  readonly packageName: string;
  readonly symbol: string;
  readonly severity: TrailStepDeprecationSeverity;
  readonly message: string;
  readonly replacement?: string;
  readonly line: number;
  readonly column: number;
  readonly installedVersion?: string;
  readonly targetVersion: string;
  readonly newlyTriggeredByThisUpdate: boolean;
}

export interface ScanWorkflowSourceOptions {
  readonly sourceFile: string;
  readonly versionsByPackageName: ReadonlyMap<
    string,
    { readonly installedVersion?: string; readonly targetVersion: string }
  >;
  readonly manifest?: readonly TrailStepDeprecationEntry[];
}

export async function scanWorkflowSourceForDeprecations({
  sourceFile,
  versionsByPackageName,
  manifest = defaultManifest,
}: ScanWorkflowSourceOptions): Promise<readonly DeprecationFinding[]> {
  const source = await readFile(sourceFile, "utf8");
  const coreManifest = toCoreManifest(manifest);
  const findings: DeprecationFinding[] = [];

  for (const token of extractTrailStepImportTokens(source)) {
    const versions = versionsByPackageName.get(token.packageName);
    if (!versions) {
      continue;
    }

    const targetStatus = findMatchingStatus(
      coreManifest,
      token.packageName,
      token.symbol,
      versions.targetVersion,
    );
    if (!targetStatus) {
      continue;
    }

    const installedStatus =
      versions.installedVersion === undefined
        ? undefined
        : findMatchingStatus(
            coreManifest,
            token.packageName,
            token.symbol,
            versions.installedVersion,
          );

    const position = lineColumnAt(source, token.offset);
    findings.push({
      sourceFile,
      packageName: token.packageName,
      symbol: token.symbol,
      severity: targetStatus.severity,
      message: targetStatus.message,
      ...(targetStatus.replacement === undefined ? {} : { replacement: targetStatus.replacement }),
      line: position.line,
      column: position.column,
      ...(versions.installedVersion === undefined
        ? {}
        : { installedVersion: versions.installedVersion }),
      targetVersion: versions.targetVersion,
      newlyTriggeredByThisUpdate:
        severityRank(targetStatus.severity) > severityRank(installedStatus?.severity ?? "none"),
    });
  }

  return findings;
}

function toCoreManifest(entries: readonly TrailStepDeprecationEntry[]): DeprecationManifest {
  return entries.map((entry) => ({
    package: entry.packageName as DeprecationTargetPackage,
    symbol: entry.symbol,
    deprecatedSince: entry.deprecatedSince,
    ...(entry.removedIn === undefined ? {} : { removedIn: entry.removedIn }),
    message: entry.message,
    ...(entry.replacement === undefined ? {} : { replacement: entry.replacement }),
  }));
}

function findMatchingStatus(
  manifest: DeprecationManifest,
  packageName: string,
  symbol: string,
  version: string,
) {
  return findDeprecationsAsOf(manifest, {
    package: packageName as DeprecationTargetPackage,
    version,
  }).find((status) => status.symbol === symbol);
}

function severityRank(severity: TrailStepDeprecationSeverityState): number {
  switch (severity) {
    case "none":
      return 0;
    case "warning":
      return 1;
    case "blocking":
      return 2;
  }
}

function lineColumnAt(
  source: string,
  offset: number,
): { readonly line: number; readonly column: number } {
  const prefix = source.slice(0, offset);
  const lines = prefix.split(/\r?\n/u);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}
