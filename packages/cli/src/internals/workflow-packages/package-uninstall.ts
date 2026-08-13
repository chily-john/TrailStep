import type {
  PackageCommandResult,
  PackageCommandRunner,
  TrailStepCliIo,
} from "../command.types.js";
import { defaultPackageCommandRunner } from "../package-manager/package-manager.js";
import {
  listRegisteredWorkflowEntries,
  type RegisteredWorkflowEntry,
  type WorkflowPackageRegistryMetadata,
  type WorkflowRegistryContext,
} from "../workflow-registry/workflow-registry.js";
import {
  workflowPackageInstallRootForMetadata,
  workflowPackageInstallSaveArgsForScope,
} from "./install-root.js";

export type RemovedWorkflowPackageInstallCleanupResult =
  | { readonly status: "none" }
  | {
      readonly status: "preserved";
      readonly packageName: string;
      readonly reason: string;
    }
  | {
      readonly status: "uninstalled";
      readonly packageName: string;
      readonly installScope: WorkflowPackageRegistryMetadata["installScope"];
      readonly installRoot: string;
    }
  | {
      readonly status: "failed";
      readonly packageName: string;
      readonly installScope: WorkflowPackageRegistryMetadata["installScope"];
      readonly installRoot: string;
      readonly exitCode?: number;
      readonly stderr?: string;
      readonly errorMessage?: string;
    };

export interface CleanupRemovedWorkflowPackageInstallOptions extends WorkflowRegistryContext {
  readonly removedEntry: Pick<RegisteredWorkflowEntry, "scope" | "targetRef" | "packageMetadata">;
  readonly packageCommandRunner?: PackageCommandRunner;
}

export interface UninstallWorkflowPackageInstallOptions extends WorkflowRegistryContext {
  readonly metadata: WorkflowPackageRegistryMetadata;
  readonly packageCommandRunner?: PackageCommandRunner;
}

export async function cleanupRemovedWorkflowPackageInstall({
  removedEntry,
  cwd,
  homeDir,
  packageCommandRunner,
}: CleanupRemovedWorkflowPackageInstallOptions): Promise<RemovedWorkflowPackageInstallCleanupResult> {
  const metadata = removedEntry.packageMetadata;
  if (metadata === undefined) {
    return { status: "none" };
  }

  if (
    metadata.targetRef !== removedEntry.targetRef ||
    metadata.installScope !== removedEntry.scope
  ) {
    return {
      status: "preserved",
      packageName: metadata.packageName,
      reason:
        "package cleanup was skipped: package metadata is stale, incomplete, or does not match the removed registration",
    };
  }

  const remainingEntries = await listRegisteredWorkflowEntries({ cwd, homeDir });
  const remainingPackageRefs = remainingEntries
    .filter((entry) =>
      entry.packageMetadata === undefined
        ? false
        : isSameWorkflowPackage(entry.packageMetadata, metadata),
    )
    .map(formatRegisteredWorkflowRef);

  if (remainingPackageRefs.length > 0) {
    return {
      status: "preserved",
      packageName: metadata.packageName,
      reason: `it is still used by ${remainingPackageRefs.join(", ")}`,
    };
  }

  const ownership = metadata.installOwnership ?? "unknown";
  if (ownership !== "trailstep-installed") {
    return {
      status: "preserved",
      packageName: metadata.packageName,
      reason: `it is not owned by TrailStep (installOwnership: ${ownership})`,
    };
  }

  const installRoot = workflowPackageInstallRootForMetadata(metadata, { cwd, homeDir });
  let result: PackageCommandResult;
  try {
    result = await uninstallWorkflowPackageInstall({
      metadata,
      cwd,
      homeDir,
      packageCommandRunner,
    });
  } catch (error) {
    return {
      status: "failed",
      packageName: metadata.packageName,
      installScope: metadata.installScope,
      installRoot,
      errorMessage: error instanceof Error ? error.message : "unknown error",
    };
  }

  if (result.exitCode !== 0) {
    return {
      status: "failed",
      packageName: metadata.packageName,
      installScope: metadata.installScope,
      installRoot,
      exitCode: result.exitCode,
      ...(result.stderr === undefined || result.stderr.length === 0
        ? {}
        : { stderr: result.stderr }),
    };
  }

  return {
    status: "uninstalled",
    packageName: metadata.packageName,
    installScope: metadata.installScope,
    installRoot,
  };
}

export async function uninstallWorkflowPackageInstall({
  metadata,
  cwd,
  homeDir,
  packageCommandRunner = defaultPackageCommandRunner,
}: UninstallWorkflowPackageInstallOptions): Promise<PackageCommandResult> {
  const installRoot = workflowPackageInstallRootForMetadata(metadata, { cwd, homeDir });
  return packageCommandRunner({
    command: "npm",
    args: [
      "uninstall",
      ...workflowPackageInstallSaveArgsForScope(metadata.installScope),
      metadata.packageName,
    ],
    cwd: installRoot,
  });
}

export function reportRemovedWorkflowPackageInstallCleanup(
  result: RemovedWorkflowPackageInstallCleanupResult,
  io: TrailStepCliIo,
): void {
  if (result.status === "none") {
    return;
  }

  if (result.status === "preserved") {
    io.writeLine(
      `Package install for ${result.packageName} was preserved because ${result.reason}.`,
    );
    return;
  }

  if (result.status === "uninstalled") {
    io.writeLine(
      `Package cleanup: uninstalled ${result.packageName} from ${result.installScope} scope.`,
    );
    return;
  }

  io.writeError(formatPackageCleanupFailure(result));
  io.writeError(
    `Registration was removed, but package cleanup for ${result.packageName} needs manual attention in ${result.installRoot}.`,
  );
}

function formatPackageCleanupFailure(
  result: Extract<RemovedWorkflowPackageInstallCleanupResult, { readonly status: "failed" }>,
): string {
  const details = [
    result.exitCode === undefined
      ? undefined
      : `npm uninstall failed with exit code ${result.exitCode}`,
    result.stderr === undefined || result.stderr.length === 0
      ? undefined
      : `stderr:\n${result.stderr.trimEnd()}`,
    result.errorMessage,
  ].filter((part): part is string => part !== undefined && part.length > 0);

  const suffix = details.length === 0 ? "unknown error" : details.join("\n");
  return `Package cleanup failed for ${result.packageName} in ${result.installScope} scope at ${result.installRoot}: ${suffix}`;
}

function isSameWorkflowPackage(
  candidate: WorkflowPackageRegistryMetadata,
  removed: WorkflowPackageRegistryMetadata,
): boolean {
  return (
    candidate.sourceType === removed.sourceType &&
    candidate.packageName === removed.packageName &&
    candidate.installScope === removed.installScope &&
    candidate.githubRef === removed.githubRef
  );
}

function formatRegisteredWorkflowRef(entry: RegisteredWorkflowEntry): string {
  return `${entry.namespace}/${entry.name}`;
}
