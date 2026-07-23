import { readFile } from "node:fs/promises";
import { deprecationManifest as coreDeprecationManifest } from "@stepkit/core";
import { gte, minVersion } from "semver";

export type StepKitDeprecationSeverity = "warning" | "blocking";

export interface StepKitDeprecationEntry {
  readonly packageName: string;
  readonly symbol: string;
  readonly deprecatedSince: string;
  readonly removedIn?: string;
  readonly message: string;
  readonly replacement?: string;
}

// Adapts @stepkit/core's manifest (field name "package") to this module's local shape (field name
// "packageName"). This is the real default used in production; tests override it via
// ScanWorkflowSourceOptions.manifest / CliCommandContext.deprecationManifest.
const defaultManifest: readonly StepKitDeprecationEntry[] = coreDeprecationManifest.map(
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
  readonly severity: StepKitDeprecationSeverity;
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
  readonly manifest?: readonly StepKitDeprecationEntry[];
}

export async function scanWorkflowSourceForDeprecations({
  sourceFile,
  versionsByPackageName,
  manifest = defaultManifest,
}: ScanWorkflowSourceOptions): Promise<readonly DeprecationFinding[]> {
  const source = await readFile(sourceFile, "utf8");
  const findings: DeprecationFinding[] = [];

  for (const importMatch of source.matchAll(
    /import\s*\{([\s\S]*?)\}\s*from\s*["'](@stepkit\/(?:core|sdk|cli))["']/gu,
  )) {
    const packageName = importMatch[2] ?? "";
    const versions = versionsByPackageName.get(packageName);
    if (!versions) {
      continue;
    }

    const specifierStart = (importMatch.index ?? 0) + (importMatch[0].indexOf("{") + 1);
    let clauseOffset = 0;
    for (const rawClause of (importMatch[1] ?? "").split(",")) {
      const currentClauseOffset = clauseOffset;
      clauseOffset += rawClause.length + 1;

      const clause = rawClause.trim();
      if (clause.length === 0) {
        continue;
      }

      // Aliased named imports (`{ step as s }`) are a documented scanner miss: once a symbol is
      // imported under an alias, the workflow's actual usage is under the new local name, and this
      // scanner is text/regex-based by design (not a type-checker), so it deliberately does not
      // try to track the alias through to its usage sites. Skip the whole clause rather than
      // matching either the original or the alias name.
      if (/^(?:type\s+)?[A-Za-z_$][\w$]*\s+as\s+[A-Za-z_$][\w$]*$/u.test(clause)) {
        continue;
      }

      const symbolMatch = /^(?:type\s+)?([A-Za-z_$][\w$]*)$/u.exec(clause);
      if (!symbolMatch) {
        continue;
      }
      const symbol = symbolMatch[1] ?? "";
      // The clause always ends with the bare symbol name (an optional "type " prefix comes
      // before it), so its offset within the untrimmed clause is its leading whitespace plus the
      // trimmed clause's length minus the symbol's own length.
      const leadingWhitespace = rawClause.length - rawClause.trimStart().length;
      const symbolIndexInClause = leadingWhitespace + clause.length - symbol.length;

      const entry = manifest.find(
        (candidate) => candidate.packageName === packageName && candidate.symbol === symbol,
      );
      if (!entry || !isTriggered(entry.deprecatedSince, versions.targetVersion)) {
        continue;
      }

      const offset = specifierStart + currentClauseOffset + symbolIndexInClause;
      const position = lineColumnAt(source, offset);
      findings.push({
        sourceFile,
        packageName,
        symbol,
        severity:
          entry.removedIn && isTriggered(entry.removedIn, versions.targetVersion)
            ? "blocking"
            : "warning",
        message: entry.message,
        ...(entry.replacement === undefined ? {} : { replacement: entry.replacement }),
        line: position.line,
        column: position.column,
        ...(versions.installedVersion === undefined
          ? {}
          : { installedVersion: versions.installedVersion }),
        targetVersion: versions.targetVersion,
        newlyTriggeredByThisUpdate:
          versions.installedVersion !== undefined &&
          !isTriggered(entry.deprecatedSince, versions.installedVersion) &&
          isTriggered(entry.deprecatedSince, versions.targetVersion),
      });
    }
  }

  return findings;
}

function isTriggered(entryVersion: string, testedVersion: string): boolean {
  const tested = minVersion(testedVersion)?.version ?? testedVersion;
  return gte(tested, entryVersion);
}

function lineColumnAt(
  source: string,
  offset: number,
): { readonly line: number; readonly column: number } {
  const prefix = source.slice(0, offset);
  const lines = prefix.split(/\r?\n/u);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}
