import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { minVersion } from "semver";

import { type CliCommand, type CliCommandContext, CliUsageError } from "../../command.types.js";
import { formatDeprecationFinding } from "../../deprecation-scan/deprecation-formatter.js";
import {
  type DeprecationFinding,
  scanWorkflowSourceForDeprecations,
} from "../../deprecation-scan/deprecation-scanner.js";
import { resolveDeprecationScanTargets } from "../../deprecation-scan/scan-targets.js";
import { NpmRegistryError } from "../../package-manager/npm-registry.js";
import { rewritePackageJsonDependencies } from "../../package-manager/package-json-rewrite.js";
import { createPackageInstallRunner } from "../../package-manager/package-manager.js";
import { parseUpdateInvocation } from "./parse-update-invocation.js";
import type { UpdateCommandArgs } from "./update-command.types.js";
import {
  resolveStepKitSelfUpdateTargets,
  type StepKitSelfUpdatePlan,
  UpdateTargetResolutionError,
} from "./update-targets.js";
import {
  resolveWorkflowPackageUpdateTargets,
  type WorkflowPackageUpdatePlan,
} from "./workflow-update-targets.js";

export const updateCommand: CliCommand<UpdateCommandArgs> = {
  name: "update",
  parseArgs: parseUpdateInvocation,
  async run(args, context) {
    try {
      const selfPlan =
        args.scope.kind === "self" || args.scope.kind === "all"
          ? await resolveStepKitSelfUpdateTargets({
              cwd: context.cwd,
              packageCommandRunner: context.packageCommandRunner,
            })
          : undefined;
      const workflowPlan =
        args.scope.kind !== "self"
          ? await resolveWorkflowPackageUpdateTargets({
              cwd: context.cwd,
              homeDir: context.homeDir,
              scope: args.scope,
            })
          : undefined;

      const findings = await collectPreflightFindings({ args, context, selfPlan, workflowPlan });
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

      const hasSelfChanges = (selfPlan?.targets.length ?? 0) > 0;
      const hasWorkflowChanges = (workflowPlan?.targets.length ?? 0) > 0;
      if (!hasSelfChanges && !hasWorkflowChanges) {
        context.io.writeLine(
          (workflowPlan?.skips.length ?? 0) > 0
            ? "No package updates to apply."
            : "No changes needed.",
        );
        return 0;
      }

      if (hasSelfChanges && selfPlan) {
        context.io.writeLine("Planned StepKit package updates:");
        for (const target of selfPlan.targets) {
          context.io.writeLine(
            `${target.packageName}: ${target.currentRange} -> ${target.targetVersion}`,
          );
        }
      }

      if (hasWorkflowChanges && workflowPlan) {
        context.io.writeLine("Planned workflow package updates:");
        for (const target of workflowPlan.targets) {
          context.io.writeLine(`  ${target.packageName} (${target.sourceFiles.join(", ")})`);
        }
      }

      if (!hasSelfChanges) {
        return 0;
      }

      const confirmed = await confirmUpdate(args, context);
      if (!confirmed) {
        context.io.writeLine("Update cancelled.");
        return 0;
      }

      await rewritePackageJsonDependencies({ cwd: context.cwd, updates: selfPlan?.targets ?? [] });
      const installResult = await createPackageInstallRunner({
        cwd: context.cwd,
        packageCommandRunner: context.packageCommandRunner,
      })();
      if (installResult.exitCode !== 0) {
        context.io.writeError(`Install failed with exit code ${installResult.exitCode}.`);
        if (installResult.stderr) {
          context.io.writeError(installResult.stderr);
        }
        return 1;
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
  readonly selfPlan?: StepKitSelfUpdatePlan;
  readonly workflowPlan?: WorkflowPackageUpdatePlan;
}

async function collectPreflightFindings({
  args,
  context,
  selfPlan,
  workflowPlan,
}: CollectPreflightFindingsOptions): Promise<readonly DeprecationFinding[]> {
  const findings: DeprecationFinding[] = [];
  const rootPackageJson = await readPackageJson(context.cwd);
  const installedVersions = readStepKitInstalledVersions(rootPackageJson);

  if (selfPlan) {
    const versionsByPackageName = new Map(installedVersions);
    for (const target of selfPlan.targets) {
      versionsByPackageName.set(target.packageName, {
        installedVersion: installedVersionFromRange(target.currentRange),
        targetVersion: target.targetVersion,
      });
    }

    const targets = await resolveDeprecationScanTargets({
      cwd: context.cwd,
      homeDir: context.homeDir,
      includeDiscovered: true,
    });
    findings.push(...(await scanTargets(targets, versionsByPackageName, context)));
  }

  if (workflowPlan) {
    const packageNames = workflowPlan.targets.map((target) => target.packageName);
    const targets = await resolveDeprecationScanTargets({
      cwd: context.cwd,
      homeDir: context.homeDir,
      packageNames,
      includeDiscovered: args.scope.kind === "all",
    });
    findings.push(...(await scanTargets(targets, installedVersions, context)));
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

async function readPackageJson(cwd: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readStepKitInstalledVersions(
  packageJson: Record<string, unknown>,
): Map<string, { readonly installedVersion?: string; readonly targetVersion: string }> {
  const versions = new Map<
    string,
    { readonly installedVersion?: string; readonly targetVersion: string }
  >();
  for (const sectionName of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const section = packageJson[sectionName];
    if (!isRecord(section)) {
      continue;
    }
    for (const packageName of ["@stepkit/core", "@stepkit/sdk", "@stepkit/cli"] as const) {
      const range = section[packageName];
      if (typeof range === "string") {
        const version = installedVersionFromRange(range);
        versions.set(packageName, { installedVersion: version, targetVersion: version ?? range });
      }
    }
  }
  return versions;
}

function installedVersionFromRange(range: string): string | undefined {
  return minVersion(range)?.version ?? (range.match(/^\d+\.\d+\.\d+/u) ? range : undefined);
}

async function confirmUpdate(
  args: UpdateCommandArgs,
  context: CliCommandContext,
): Promise<boolean> {
  if (args.yes) {
    return true;
  }
  if (!context.prompts?.confirm) {
    throw new CliUsageError(
      "Update requires --yes or an interactive confirm prompt before writing.",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
