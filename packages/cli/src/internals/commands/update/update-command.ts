import { type CliCommand, type CliCommandContext, CliUsageError } from "../../command.types.js";
import { formatDeprecationFinding } from "../../deprecation-scan/deprecation-formatter.js";
import {
  type DeprecationFinding,
  scanWorkflowSourceForDeprecations,
} from "../../deprecation-scan/deprecation-scanner.js";
import { resolveInstalledTrailStepVersions } from "../../deprecation-scan/resolve-installed-trailstep-versions.js";
import { resolveDeprecationScanTargets } from "../../deprecation-scan/scan-targets.js";
import { NpmRegistryError } from "../../package-manager/npm-registry.js";
import {
  type PackageJsonDependencyUpdate,
  preserveRangeStyle,
  rewritePackageJsonDependencies,
} from "../../package-manager/package-json-rewrite.js";
import {
  defaultPackageCommandRunner,
  detectPackageManager,
} from "../../package-manager/package-manager.js";
import { refreshTrackedPackagedTrailStepSkills } from "../../trailstep-skill/trailstep-skill.js";
import {
  type GlobalCliUpdatePlan,
  resolveGlobalCliUpdateTarget,
} from "./global-cli-update-target.js";
import { parseUpdateInvocation } from "./parse-update-invocation.js";
import type { UpdateCommandArgs } from "./update-command.types.js";
import {
  resolveTrailStepSelfUpdateTargets,
  type TrailStepSelfUpdatePlan,
  UpdateTargetResolutionError,
} from "./update-targets.js";
import {
  resolveWorkflowPackageUpdateTargets,
  type WorkflowPackageUpdatePlan,
  type WorkflowPackageUpdateTarget,
} from "./workflow-update-targets.js";

export const updateCommand: CliCommand<UpdateCommandArgs> = {
  name: "update",
  parseArgs: parseUpdateInvocation,
  async run(args, context) {
    try {
      const globalCliPlan =
        args.scope.kind === "global" || args.scope.kind === "all"
          ? await resolveGlobalCliUpdateTarget({
              cwd: context.cwd,
              packageCommandRunner: context.packageCommandRunner,
            })
          : undefined;
      const selfPlan =
        args.scope.kind === "project" || args.scope.kind === "all"
          ? await resolveTrailStepSelfUpdateTargets({
              cwd: context.cwd,
              packageCommandRunner: context.packageCommandRunner,
            })
          : undefined;
      const workflowPlan =
        args.scope.kind === "all" ||
        args.scope.kind === "workflows" ||
        args.scope.kind === "workflow"
          ? await resolveWorkflowPackageUpdateTargets({
              cwd: context.cwd,
              homeDir: context.homeDir,
              scope: args.scope,
              packageCommandRunner: context.packageCommandRunner,
            })
          : undefined;

      const workflowTargetsToApply = (workflowPlan?.targets ?? []).filter(
        isChangedDependencyUpdate,
      );
      const workflowPlanToApply =
        workflowPlan === undefined
          ? undefined
          : { ...workflowPlan, targets: workflowTargetsToApply };

      const findings = await collectPreflightFindings({
        args,
        context,
        selfPlan,
        workflowPlan: workflowPlanToApply,
      });
      const blocked = findings.some((finding) => finding.severity === "blocking");
      for (const finding of findings) {
        context.io.writeLine(formatDeprecationFinding(finding));
      }
      if (blocked && !args.force) {
        context.io.writeError(
          "Update blocked: blocking deprecation findings found. Re-run with --force to continue.",
        );
        return 1;
      }
      if (blocked && args.force) {
        context.io.writeLine(
          "Warning: --force set; continuing despite blocking deprecation findings.",
        );
      }

      for (const skip of workflowPlan?.skips ?? []) {
        context.io.writeLine(skip.message);
      }

      const hasGlobalCliChanges = (globalCliPlan?.targets.length ?? 0) > 0;
      const hasSelfChanges = (selfPlan?.targets.length ?? 0) > 0;
      const hasWorkflowChanges = workflowTargetsToApply.length > 0;
      if (!hasGlobalCliChanges && !hasSelfChanges && !hasWorkflowChanges) {
        context.io.writeLine(noChangesMessage(args, globalCliPlan, selfPlan, workflowPlan));
        return 0;
      }

      if (hasGlobalCliChanges && globalCliPlan) {
        context.io.writeLine("Planned global TrailStep CLI update:");
        for (const target of globalCliPlan.targets) {
          context.io.writeLine(
            `${target.packageName}: ${target.currentVersion} -> ${target.targetVersion} (${target.command} ${target.args.join(" ")})`,
          );
        }
      }

      if (hasSelfChanges && selfPlan) {
        context.io.writeLine("Planned TrailStep package updates:");
        for (const target of selfPlan.targets) {
          context.io.writeLine(
            `${target.packageName}: ${target.currentRange} -> ${target.targetVersion}`,
          );
        }
      }

      if (hasWorkflowChanges) {
        context.io.writeLine("Planned workflow package updates:");
        for (const target of workflowTargetsToApply) {
          context.io.writeLine(
            `  ${target.packageName} (${target.installScope} install root: ${target.installRoot}): ${target.currentRange} -> ${target.targetVersion}`,
          );
        }
      }

      const updateGroups = createDependencyUpdateGroups({
        cwd: context.cwd,
        selfUpdates: selfPlan?.targets ?? [],
        workflowUpdates: workflowTargetsToApply,
      });
      const confirmed = await confirmUpdate(args, context);
      if (!confirmed) {
        context.io.writeLine("Update cancelled.");
        return 0;
      }

      const runPackageCommand = context.packageCommandRunner ?? defaultPackageCommandRunner;
      if (globalCliPlan) {
        for (const target of globalCliPlan.targets) {
          const installResult = await runPackageCommand({
            command: target.command,
            args: target.args,
            cwd: context.cwd,
          });
          if (installResult.exitCode !== 0) {
            context.io.writeError(
              `Global TrailStep CLI update failed with exit code ${installResult.exitCode}.`,
            );
            if (installResult.stderr) {
              context.io.writeError(installResult.stderr);
            }
            return 1;
          }
          context.io.writeLine(
            "Updated global TrailStep CLI. The updated binary will be used by the next trailstep process.",
          );
          await refreshTrailStepSkillAfterGlobalCliUpdate(context);
        }
      }

      for (const group of updateGroups) {
        await rewritePackageJsonDependencies({ cwd: group.installRoot, updates: group.updates });
        const packageManager = await detectPackageManager({ cwd: group.installRoot });
        for (const warning of packageManager.warnings) {
          context.io.writeLine(warning);
        }
        const installResult = await runPackageCommand({
          command: packageManager.installCommand.command,
          args: packageManager.installCommand.args,
          cwd: group.installRoot,
        });
        if (installResult.exitCode !== 0) {
          // package.json may already contain the rewritten dependency ranges; users can recover
          // by fixing the install issue and re-running their package manager install command.
          context.io.writeError(
            `Install failed with exit code ${installResult.exitCode} in ${group.installRoot}.`,
          );
          if (installResult.stderr) {
            context.io.writeError(installResult.stderr);
          }
          return 1;
        }
      }
      context.io.writeLine("Update complete.");
      return 0;
    } catch (error) {
      if (error instanceof NpmRegistryError || error instanceof UpdateTargetResolutionError) {
        context.io.writeError(error.message);
        return 1;
      }
      throw error;
    }
  },
};

interface CollectPreflightFindingsOptions {
  readonly args: UpdateCommandArgs;
  readonly context: CliCommandContext;
  readonly selfPlan?: TrailStepSelfUpdatePlan;
  readonly workflowPlan?: WorkflowPackageUpdatePlan;
}

async function collectPreflightFindings({
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

async function refreshTrailStepSkillAfterGlobalCliUpdate(
  context: CliCommandContext,
): Promise<void> {
  try {
    const refreshed = await refreshTrackedPackagedTrailStepSkills(context);
    if (refreshed.length > 0) {
      context.io.writeLine("Refreshed tracked TrailStep usage skill installation(s).");
    }
  } catch (error) {
    context.io.writeError(
      `Warning: failed to refresh tracked TrailStep usage skill installation(s): ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
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

interface DependencyUpdateGroup {
  readonly installRoot: string;
  readonly updates: readonly PackageJsonDependencyUpdate[];
}

function createDependencyUpdateGroups({
  cwd,
  selfUpdates,
  workflowUpdates,
}: {
  readonly cwd: string;
  readonly selfUpdates: readonly PackageJsonDependencyUpdate[];
  readonly workflowUpdates: readonly WorkflowPackageUpdateTarget[];
}): readonly DependencyUpdateGroup[] {
  const groups = new Map<string, PackageJsonDependencyUpdate[]>();
  addDependencyUpdates(groups, cwd, selfUpdates);
  for (const update of workflowUpdates) {
    addDependencyUpdates(groups, update.installRoot, [update]);
  }
  return [...groups.entries()].map(([installRoot, updates]) => ({ installRoot, updates }));
}

function addDependencyUpdates(
  groups: Map<string, PackageJsonDependencyUpdate[]>,
  installRoot: string,
  updates: readonly PackageJsonDependencyUpdate[],
): void {
  if (updates.length === 0) {
    return;
  }

  let group = groups.get(installRoot);
  if (!group) {
    group = [];
    groups.set(installRoot, group);
  }

  for (const update of updates) {
    group.push({
      packageName: update.packageName,
      targetVersion: update.targetVersion,
      dependencySection: update.dependencySection,
    });
  }
}

function isChangedDependencyUpdate(update: {
  readonly currentRange: string;
  readonly targetVersion: string;
}): boolean {
  return preserveRangeStyle(update.currentRange, update.targetVersion) !== update.currentRange;
}

function noChangesMessage(
  args: UpdateCommandArgs,
  globalCliPlan: GlobalCliUpdatePlan | undefined,
  selfPlan: TrailStepSelfUpdatePlan | undefined,
  workflowPlan: WorkflowPackageUpdatePlan | undefined,
): string {
  if (args.scope.kind === "global" && globalCliPlan) {
    return `Global TrailStep CLI is already current (@trailstep/cli ${globalCliPlan.currentVersion}).`;
  }
  if (args.scope.kind === "workflows" || args.scope.kind === "workflow") {
    return "No workflow package updates are available.";
  }
  if (args.scope.kind === "project" && (selfPlan?.currentPackageNames.length ?? 0) === 0) {
    return "No TrailStep package dependencies found in package.json; add @trailstep/cli to this project or update a global CLI install with your package manager.";
  }
  return (workflowPlan?.skips.length ?? 0) > 0
    ? "No package updates to apply."
    : "No changes needed.";
}

async function confirmUpdate(
  args: UpdateCommandArgs,
  context: CliCommandContext,
): Promise<boolean> {
  if (args.assumeYes) {
    return true;
  }
  if (!context.prompts?.confirm) {
    throw new CliUsageError(
      "Update requires --yes, --assume-yes, or an interactive confirm prompt before writing.",
    );
  }
  return context.prompts.confirm("Apply package updates and run install?");
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
