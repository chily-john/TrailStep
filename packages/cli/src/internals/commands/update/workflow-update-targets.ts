import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PackageCommandRunner } from "../../command.types.js";
import { resolveBundleWorkflowScanTargets } from "../../deprecation-scan/scan-targets.js";
import {
  resolveInstalledPackageManifest,
  resolvePackageEntryFilePath,
} from "../../discovery/discovery.js";
import { fetchNpmPackageMetadata } from "../../package-manager/npm-registry.js";
import { workflowPackageInstallRootForMetadata } from "../../workflow-packages/install-root.js";
import { parseBundleWorkflowId } from "../../workflow-reference/workflow-reference.js";
import {
  listRegisteredWorkflowEntries,
  type RegisteredWorkflowEntry,
  type WorkflowPackageRegistryMetadata,
  type WorkflowRegistryScope,
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

type WorkflowPackageUpdateSourceType = Extract<
  WorkflowPackageRegistryMetadata["sourceType"],
  "npm"
>;

export interface WorkflowPackageUpdateTarget {
  readonly packageName: string;
  readonly sourceType: WorkflowPackageUpdateSourceType;
  readonly installScope: WorkflowRegistryScope;
  readonly installRoot: string;
  readonly registeredRefs: readonly string[];
  readonly currentRange: string;
  readonly dependencySection: DependencySection;
  readonly installedVersion?: string;
  readonly targetVersion: string;
  readonly sourceFiles: readonly string[];
}

export interface WorkflowPackageUpdateSkip {
  readonly registeredRef: string;
  readonly reason:
    | "local-file-source"
    | "unsupported-source-type"
    | "stale-package-metadata"
    | "missing-package-metadata";
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
  sourceType: WorkflowPackageUpdateSourceType;
  installScope: WorkflowRegistryScope;
  installRoot: string;
  githubRef?: string;
  registeredRefs: string[];
}

type WorkflowPackageTargetSeed = Omit<MutableWorkflowPackageUpdateTarget, "registeredRefs">;

type ResolvedWorkflowPackageEntryTarget =
  | { readonly kind: "target"; readonly target: WorkflowPackageTargetSeed }
  | { readonly kind: "skip"; readonly skip: WorkflowPackageUpdateSkip };

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
  const targetsByInstallKey = new Map<string, MutableWorkflowPackageUpdateTarget>();
  const skips: WorkflowPackageUpdateSkip[] = [];

  for (const entry of scopedEntries) {
    const registeredRef = `${entry.namespace}/${entry.name}`;
    const resolved = resolveWorkflowPackageTargetForEntry(entry, { cwd, homeDir, registeredRef });
    if (resolved.kind === "skip") {
      skips.push(resolved.skip);
      continue;
    }

    addPackageTarget(targetsByInstallKey, resolved.target, registeredRef);
  }

  const targets: WorkflowPackageUpdateTarget[] = [];
  for (const target of targetsByInstallKey.values()) {
    targets.push(await createWorkflowPackageUpdateTarget({ target, packageCommandRunner }));
  }

  return { targets, skips };
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

function resolveWorkflowPackageTargetForEntry(
  entry: RegisteredWorkflowEntry,
  context: {
    readonly cwd: string;
    readonly homeDir?: string;
    readonly registeredRef: string;
  },
): ResolvedWorkflowPackageEntryTarget {
  const targetRefPackageName = packageNameFromWorkflowTarget(entry.targetRef);
  if (targetRefPackageName === undefined) {
    return {
      kind: "skip",
      skip: {
        registeredRef: context.registeredRef,
        reason: "local-file-source",
        message: `Skipped ${context.registeredRef}: local file source, no version to update.`,
      },
    };
  }

  if (entry.packageMetadata !== undefined) {
    const metadata = entry.packageMetadata;
    if (metadata.targetRef !== entry.targetRef || metadata.packageName !== targetRefPackageName) {
      return {
        kind: "skip",
        skip: {
          registeredRef: context.registeredRef,
          reason: "stale-package-metadata",
          message: `Skipped ${context.registeredRef}: workflow package metadata is stale; re-add the workflow before updating this package.`,
        },
      };
    }

    if (metadata.sourceType === "github") {
      return {
        kind: "skip",
        skip: {
          registeredRef: context.registeredRef,
          reason: "unsupported-source-type",
          message: `Skipped ${context.registeredRef}: GitHub workflow package updates are not supported yet.`,
        },
      };
    }

    return {
      kind: "target",
      target: {
        packageName: metadata.packageName,
        sourceType: metadata.sourceType,
        installScope: metadata.installScope,
        installRoot: workflowPackageInstallRootForMetadata(metadata, context),
      },
    };
  }

  return {
    kind: "skip",
    skip: {
      registeredRef: context.registeredRef,
      reason: "missing-package-metadata",
      message: `Skipped ${context.registeredRef}: workflow package metadata is missing; re-add the workflow before updating this package.`,
    },
  };
}

function addPackageTarget(
  targetsByInstallKey: Map<string, MutableWorkflowPackageUpdateTarget>,
  targetSeed: WorkflowPackageTargetSeed,
  registeredRef?: string,
): void {
  const installKey = workflowPackageInstallKey(targetSeed);
  const target = targetsByInstallKey.get(installKey) ?? {
    ...targetSeed,
    registeredRefs: [],
  };

  if (registeredRef !== undefined && !target.registeredRefs.includes(registeredRef)) {
    target.registeredRefs.push(registeredRef);
  }

  targetsByInstallKey.set(installKey, target);
}

function workflowPackageInstallKey(target: WorkflowPackageTargetSeed): string {
  return [target.sourceType, target.packageName, target.installRoot, target.githubRef ?? ""].join(
    "\0",
  );
}

async function createWorkflowPackageUpdateTarget({
  target,
  packageCommandRunner,
}: {
  readonly target: MutableWorkflowPackageUpdateTarget;
  readonly packageCommandRunner?: PackageCommandRunner;
}): Promise<WorkflowPackageUpdateTarget> {
  const packageJson = await readInstallRootPackageJson(target);
  const current = readPackageDependencyEntry(packageJson, target.packageName);
  if (!current) {
    throw new UpdateTargetResolutionError(
      `Cannot update ${target.packageName}: package is not listed in root dependencies, devDependencies, or peerDependencies.`,
    );
  }

  const [installedVersion, metadata] = await Promise.all([
    readInstalledPackageVersion(target.installRoot, target.packageName),
    fetchNpmPackageMetadata({
      cwd: target.installRoot,
      packageName: target.packageName,
      packageCommandRunner,
    }),
  ]);
  const targetVersion = selectLatestStable(metadata.versions);
  if (!targetVersion) {
    throw new UpdateTargetResolutionError(
      `No published ${target.packageName} versions were found.`,
    );
  }

  return {
    packageName: target.packageName,
    sourceType: target.sourceType,
    installScope: target.installScope,
    installRoot: target.installRoot,
    registeredRefs: target.registeredRefs,
    currentRange: current.range,
    dependencySection: current.section,
    installedVersion,
    targetVersion,
    sourceFiles: await resolveWorkflowPackageSourceFiles(target.installRoot, target.packageName),
  };
}

async function readInstallRootPackageJson(
  target: Pick<MutableWorkflowPackageUpdateTarget, "installRoot" | "packageName">,
): Promise<Record<string, unknown>> {
  try {
    return await readRootPackageJson(target.installRoot);
  } catch {
    throw new UpdateTargetResolutionError(
      `Cannot update ${target.packageName}: failed to read package.json from install root ${target.installRoot}.`,
    );
  }
}

async function resolveWorkflowPackageSourceFiles(
  installRoot: string,
  packageName: string,
): Promise<readonly string[]> {
  const bundleTargets = await resolveBundleWorkflowScanTargets(packageName, installRoot);
  if (bundleTargets.length > 0) {
    return bundleTargets.map((target) => target.sourceFile);
  }

  const manifest = await resolveInstalledPackageManifest(packageName, installRoot);
  if (manifest === undefined) {
    return [];
  }
  return [resolvePackageEntryFilePath(manifest.packageJson, manifest.packageDir)];
}

async function readInstalledPackageVersion(
  installRoot: string,
  packageName: string,
): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(join(installRoot, "node_modules", packageName, "package.json"), "utf8"),
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
