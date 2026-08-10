import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PackageCommandRunner } from "../../command.types.js";
import { resolveBundleWorkflowScanTargets } from "../../deprecation-scan/scan-targets.js";
import {
  resolveInstalledPackageManifest,
  resolvePackageEntryFilePath,
} from "../../discovery/discovery.js";
import { fetchNpmPackageMetadata } from "../../package-manager/npm-registry.js";
import { parseBundleWorkflowId } from "../../workflow-reference/workflow-reference.js";
import {
  listRegisteredWorkflowEntries,
  type RegisteredWorkflowEntry,
} from "../../workflow-registry/workflow-registry.js";
import { isDirectWorkflowFileReference } from "../../workflow-resolution/workflow-resolution.js";
import type { UpdateScope } from "./update-command.types.js";
import {
  type DependencySection,
  readPackageDependencyEntry,
  readRootPackageJson,
  selectLatestStable,
  UpdateTargetResolutionError,
} from "./update-targets.js";

export interface WorkflowPackageUpdateTarget {
  readonly packageName: string;
  readonly registeredRefs: readonly string[];
  readonly currentRange: string;
  readonly dependencySection: DependencySection;
  readonly installedVersion?: string;
  readonly targetVersion: string;
  readonly sourceFiles: readonly string[];
}

export interface WorkflowPackageUpdateSkip {
  readonly registeredRef: string;
  readonly reason: "local-file-source";
  readonly message: string;
}

export interface WorkflowPackageUpdatePlan {
  readonly targets: readonly WorkflowPackageUpdateTarget[];
  readonly skips: readonly WorkflowPackageUpdateSkip[];
}

export interface ResolveWorkflowPackageUpdateTargetsOptions {
  readonly cwd: string;
  readonly homeDir?: string;
  readonly scope: Extract<UpdateScope, { kind: "all" | "workflows" | "workflow" }>;
  readonly packageCommandRunner?: PackageCommandRunner;
}

interface MutableWorkflowPackageUpdateTarget {
  packageName: string;
  registeredRefs: string[];
}

// This module deliberately never calls discoverWorkflows(). Plain npm trailstep-workflow-keyword
// dependencies are out of scope for `trailstep update` — they are ordinary entries in the consumer's
// own package.json and ride the consumer's normal package-manager update on their whole project.
// `update` only ever acts on entries that went through `trailstep add` (the config registry).
export async function resolveWorkflowPackageUpdateTargets({
  cwd,
  homeDir,
  scope,
  packageCommandRunner,
}: ResolveWorkflowPackageUpdateTargetsOptions): Promise<WorkflowPackageUpdatePlan> {
  const entries = await listRegisteredWorkflowEntries({ cwd, homeDir });
  const scopedEntries =
    scope.kind === "workflow" ? entriesForWorkflow(entries, scope.name) : entries;
  const targetsByPackageName = new Map<string, MutableWorkflowPackageUpdateTarget>();
  const skips: WorkflowPackageUpdateSkip[] = [];

  for (const entry of scopedEntries) {
    const registeredRef = `${entry.namespace}/${entry.name}`;
    const packageName = packageNameFromWorkflowTarget(entry.targetRef);
    if (packageName === undefined) {
      skips.push({
        registeredRef,
        reason: "local-file-source",
        message: `Skipped ${registeredRef}: local file source, no version to update.`,
      });
      continue;
    }

    addPackageTarget(targetsByPackageName, packageName, registeredRef);
  }

  if (scope.kind === "workflow" && scopedEntries.length === 0) {
    addPackageTarget(targetsByPackageName, packageNameFromRawWorkflowPackage(scope.name));
  }

  return {
    targets: await Promise.all(
      [...targetsByPackageName.values()].map((target) =>
        createWorkflowPackageUpdateTarget({ cwd, target, packageCommandRunner }),
      ),
    ),
    skips,
  };
}

function entriesForWorkflow(
  entries: readonly RegisteredWorkflowEntry[],
  workflowName: string,
): readonly RegisteredWorkflowEntry[] {
  const fullRefMatches = entries.filter(
    (entry) => `${entry.namespace}/${entry.name}` === workflowName,
  );
  if (fullRefMatches.length > 0) {
    return fullRefMatches;
  }

  const bareNameMatches = entries.filter((entry) => entry.name === workflowName);
  if (bareNameMatches.length > 1) {
    throw new UpdateTargetResolutionError(
      `Ambiguous workflow name "${workflowName}" matches ${bareNameMatches
        .map((entry) => `${entry.namespace}/${entry.name}`)
        .join(", ")}.`,
    );
  }
  return bareNameMatches;
}

function addPackageTarget(
  targetsByPackageName: Map<string, MutableWorkflowPackageUpdateTarget>,
  packageName: string,
  registeredRef?: string,
): void {
  const target = targetsByPackageName.get(packageName) ?? {
    packageName,
    registeredRefs: [],
  };

  if (registeredRef !== undefined && !target.registeredRefs.includes(registeredRef)) {
    target.registeredRefs.push(registeredRef);
  }

  targetsByPackageName.set(packageName, target);
}

async function createWorkflowPackageUpdateTarget({
  cwd,
  target,
  packageCommandRunner,
}: {
  readonly cwd: string;
  readonly target: MutableWorkflowPackageUpdateTarget;
  readonly packageCommandRunner?: PackageCommandRunner;
}): Promise<WorkflowPackageUpdateTarget> {
  const packageJson = await readRootPackageJson(cwd);
  const current = readPackageDependencyEntry(packageJson, target.packageName);
  if (!current) {
    throw new UpdateTargetResolutionError(
      `Cannot update ${target.packageName}: package is not listed in root dependencies, devDependencies, or peerDependencies.`,
    );
  }

  const [installedVersion, metadata] = await Promise.all([
    readInstalledPackageVersion(cwd, target.packageName),
    fetchNpmPackageMetadata({ cwd, packageName: target.packageName, packageCommandRunner }),
  ]);
  const targetVersion = selectLatestStable(metadata.versions);
  if (!targetVersion) {
    throw new UpdateTargetResolutionError(
      `No published ${target.packageName} versions were found.`,
    );
  }

  return {
    packageName: target.packageName,
    registeredRefs: target.registeredRefs,
    currentRange: current.range,
    dependencySection: current.section,
    installedVersion,
    targetVersion,
    sourceFiles: await resolveWorkflowPackageSourceFiles(cwd, target.packageName),
  };
}

async function resolveWorkflowPackageSourceFiles(
  cwd: string,
  packageName: string,
): Promise<readonly string[]> {
  const bundleTargets = await resolveBundleWorkflowScanTargets(packageName, cwd);
  if (bundleTargets.length > 0) {
    return bundleTargets.map((target) => target.sourceFile);
  }

  const manifest = await resolveInstalledPackageManifest(packageName, cwd);
  if (manifest === undefined) {
    return [];
  }
  return [resolvePackageEntryFilePath(manifest.packageJson, manifest.packageDir)];
}

async function readInstalledPackageVersion(
  cwd: string,
  packageName: string,
): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(join(cwd, "node_modules", packageName, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

function packageNameFromWorkflowTarget(targetRef: string): string | undefined {
  if (
    isDirectWorkflowFileReference(targetRef) ||
    targetRef === "~" ||
    targetRef.startsWith("~/") ||
    targetRef.startsWith("~\\")
  ) {
    return undefined;
  }

  const bundleRef = parseBundleWorkflowId(targetRef);
  if (bundleRef) {
    return bundleRef.packageName;
  }

  const legacySeparatorIndex = targetRef.lastIndexOf(":");
  if (legacySeparatorIndex > 0 && legacySeparatorIndex < targetRef.length - 1) {
    return targetRef.slice(0, legacySeparatorIndex);
  }

  return targetRef;
}

function packageNameFromRawWorkflowPackage(rawPackageName: string): string {
  const packageName = packageNameFromWorkflowTarget(rawPackageName);
  return packageName ?? rawPackageName;
}
