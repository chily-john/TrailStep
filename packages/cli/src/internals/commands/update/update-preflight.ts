import type { CliCommandContext } from "../../command-framework/command.types.js";
import {
  type DeprecationFinding,
  scanWorkflowSourceForDeprecations,
} from "../../deprecation-scan/deprecation-scanner.js";
import { resolveInstalledTrailStepVersions } from "../../deprecation-scan/resolve-installed-trailstep-versions.js";
import { resolveDeprecationScanTargets } from "../../deprecation-scan/scan-targets.js";
import type { UpdateCommandArgs } from "./update-command.types.js";
import type { TrailStepSelfUpdatePlan } from "./update-targets.js";
import type { WorkflowPackageUpdatePlan } from "./workflow-update-targets.js";

export interface CollectPreflightFindingsOptions {
  readonly args: UpdateCommandArgs;
  readonly context: CliCommandContext;
  readonly selfPlan?: TrailStepSelfUpdatePlan;
  readonly workflowPlan?: WorkflowPackageUpdatePlan;
}

/**
 * Scans the sources that the planned update would touch for deprecated
 * TrailStep APIs. Findings are advisory except for `blocking` ones, which
 * stop the update unless `--force` is passed.
 */
export async function collectPreflightFindings({
  args,
  context,
  selfPlan,
  workflowPlan,
}: CollectPreflightFindingsOptions): Promise<readonly DeprecationFinding[]> {
  const findings: DeprecationFinding[] = [];
  const installedVersions = await resolveInstalledTrailStepVersions({ cwd: context.cwd });
  const targetTrailStepVersions = selfPlan
    ? versionsForPreflight(installedVersions, selfPlan)
    : installedVersions;

  if (selfPlan) {
    const versionsByPackageName = targetTrailStepVersions;

    const targets = await resolveDeprecationScanTargets({
      cwd: context.cwd,
      homeDir: context.homeDir,
      includeDiscovered: true,
    });
    findings.push(...(await scanTargets(targets, versionsByPackageName, context)));
  }

  if (workflowPlan) {
    const targets = workflowPlan.targets.flatMap((target) =>
      target.sourceFiles.map((sourceFile) => ({ sourceFile })),
    );
    const versionsByPackageName =
      args.scope.kind === "all" ? targetTrailStepVersions : installedVersions;
    findings.push(...(await scanTargets(targets, versionsByPackageName, context)));
  }

  return dedupeFindings(findings);
}

async function scanTargets(
  targets: readonly { readonly sourceFile: string }[],
  versionsByPackageName: ReadonlyMap<
    string,
    { readonly installedVersion?: string; readonly targetVersion: string }
  >,
  context: CliCommandContext,
): Promise<readonly DeprecationFinding[]> {
  const findings: DeprecationFinding[] = [];
  for (const target of targets) {
    try {
      findings.push(
        ...(await scanWorkflowSourceForDeprecations({
          sourceFile: target.sourceFile,
          versionsByPackageName,
          manifest: context.deprecationManifest,
        })),
      );
    } catch {
      // Missing/unreadable targets are non-finding scan skips for update preflight.
    }
  }
  return findings;
}

function versionsForPreflight(
  installedVersions: ReadonlyMap<
    string,
    { readonly installedVersion?: string; readonly targetVersion: string }
  >,
  selfPlan: TrailStepSelfUpdatePlan,
): Map<string, { readonly installedVersion?: string; readonly targetVersion: string }> {
  const versionsByPackageName = new Map(installedVersions);
  for (const target of selfPlan.targets) {
    const installedVersion = installedVersions.get(target.packageName)?.installedVersion;
    versionsByPackageName.set(target.packageName, {
      ...(installedVersion === undefined ? {} : { installedVersion }),
      targetVersion: target.targetVersion,
    });
  }
  return versionsByPackageName;
}

function dedupeFindings(findings: readonly DeprecationFinding[]): readonly DeprecationFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.sourceFile}\0${finding.packageName}\0${finding.symbol}\0${finding.line}\0${finding.column}\0${finding.targetVersion}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
