import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import { promptMultiSelect, promptSelect } from "../../prompts/prompt-helpers.js";
import { workflowPackageInstallRootForScope } from "../../workflow-packages/install-root.js";
import {
  type InstalledNpmWorkflowPackage,
  installNpmWorkflowPackage,
} from "../../workflow-packages/npm-package-installer.js";
import {
  createWorkflowPackageInstallSnapshot,
  rollbackWorkflowPackageInstall,
  type WorkflowPackageInstallSnapshot,
} from "../../workflow-packages/package-install-rollback.js";
import {
  type ParsedWorkflowPackageRef,
  parseWorkflowPackageRef,
} from "../../workflow-packages/package-ref.js";
import type {
  WorkflowPackageRegistryMetadata,
  WorkflowRegistryScope,
} from "../../workflow-registry/workflow-registry.js";
import {
  type BundleWorkflowSpecifier,
  hasBundleWorkflowManifest,
  listBundleWorkflowNames,
  loadBundleWorkflow,
} from "../../workflow-resolution/bundle-resolver.js";
import { loadDirectWorkflowExports } from "../../workflow-resolution/direct-file-resolver.js";
import { isDirectWorkflowFileReference } from "../../workflow-resolution/workflow-resolution.js";
import { WorkflowResolutionError } from "../../workflow-resolution/workflow-resolution-error.js";
import type { WorkflowSkillMetadata } from "../../workflow-skills/workflow-skill-content.js";

import type {
  AddRegistryTarget,
  AddWorkflowCandidate,
  PreparedAddSource,
  SourceResolutionArgs,
} from "./add-command.types.js";
import { isNodeError, isRecord } from "./record-utils.js";

const SELECT_ALL_WORKFLOWS_CHOICE = "Select all";
const EXISTING_PACKAGE_PROMPT_CHOICES = [
  "Reuse installed package",
  "Reinstall/upgrade",
  "Cancel",
] as const;

interface PrepareAddSourceOptions {
  readonly headless: boolean;
}

export async function prepareAddSource(
  source: string,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
  options: PrepareAddSourceOptions,
): Promise<PreparedAddSource> {
  const packageRef = parseWorkflowPackageRef(source);
  if (packageRef === undefined) {
    return { status: "ready", source, cwd: context.cwd };
  }

  if (packageRef.sourceType === "npm" && !packageRef.versionExplicit) {
    // Bare names (e.g. `@trailstep/create-flows`) are ambiguous: they may name
    // an already-installed bundle or a package to install. Prefer the installed
    // bundle when it resolves at the scope's install root so re-adding stays
    // install-free; otherwise fall through and install `@latest`.
    const installRoot = workflowPackageInstallRootForScope(scope, context);
    try {
      const installedNames = await listBundleWorkflowNames(packageRef.packageName, {
        cwd: installRoot,
      });
      if (installedNames.length > 0) {
        return { status: "ready", source: packageRef.packageName, cwd: installRoot };
      }
    } catch {
      // Not resolvable locally; continue to the install path below.
    }
  }

  const availablePackage = await ensureNpmWorkflowPackageAvailable({
    packageRef,
    scope,
    context,
    headless: options.headless,
  });
  if (availablePackage.installAction === "cancel") {
    context.io.writeLine("Canceled.");
    return { status: "cancelled" };
  }
  if (availablePackage.installAction === "install") {
    context.io.writeLine(`Installed ${packageRef.requestedSpec} in ${scope} scope.`);
  } else {
    context.io.writeLine(`Using installed ${availablePackage.packageName} in ${scope} scope.`);
  }
  return {
    status: "ready",
    source: availablePackage.installedPackage.packageName,
    cwd: availablePackage.installedPackage.installRoot,
    installedPackage: availablePackage.installedPackage,
    ...(availablePackage.installSnapshot === undefined
      ? {}
      : { installSnapshot: availablePackage.installSnapshot }),
  };
}

type EnsurePackageInstallAction = "reuse" | "install" | "cancel";

interface EnsureNpmWorkflowPackageAvailableOptions {
  readonly packageRef: ParsedWorkflowPackageRef;
  readonly scope: WorkflowRegistryScope;
  readonly context: CliCommandContext;
  readonly headless: boolean;
}

type EnsureNpmWorkflowPackageAvailableResult =
  | {
      readonly installAction: Exclude<EnsurePackageInstallAction, "cancel">;
      readonly installRoot: string;
      readonly packageName: string;
      readonly installedPackage: InstalledNpmWorkflowPackage;
      readonly resolvedVersion?: string;
      readonly installSnapshot?: WorkflowPackageInstallSnapshot;
    }
  | {
      readonly installAction: "cancel";
      readonly installRoot: string;
      readonly packageName: string;
      readonly resolvedVersion?: string;
    };

async function ensureNpmWorkflowPackageAvailable({
  packageRef,
  scope,
  context,
  headless,
}: EnsureNpmWorkflowPackageAvailableOptions): Promise<EnsureNpmWorkflowPackageAvailableResult> {
  const installRoot = workflowPackageInstallRootForScope(scope, context);
  const existingPackage = await readExistingInstalledNpmWorkflowPackage(
    packageRef,
    scope,
    installRoot,
  );

  if (existingPackage !== undefined) {
    if (headless) {
      return ensurePackageAvailableResult("reuse", existingPackage);
    }

    writeExistingPackageSummary(existingPackage, packageRef, scope, context);
    const action = await promptSelect(
      existingPackagePrompt(existingPackage.packageName, scope),
      EXISTING_PACKAGE_PROMPT_CHOICES,
      context.prompts,
      `Package ${existingPackage.packageName} is already installed in ${scope} scope. Run interactively to choose reuse, reinstall/upgrade, or cancel.`,
    );
    if (action === "Cancel") {
      return {
        installAction: "cancel",
        installRoot,
        packageName: existingPackage.packageName,
        ...(existingPackage.resolvedVersion === undefined
          ? {}
          : { resolvedVersion: existingPackage.resolvedVersion }),
      };
    }
    if (action === "Reuse installed package") {
      return ensurePackageAvailableResult("reuse", existingPackage);
    }
  }

  const installSnapshot = await createWorkflowPackageInstallSnapshot({
    installRoot,
    ...(packageRef.sourceType === "npm" ? { packageName: packageRef.packageName } : {}),
  });
  return ensurePackageAvailableResult(
    "install",
    await installNpmWorkflowPackage({
      packageRef,
      scope,
      cwd: context.cwd,
      homeDir: context.homeDir,
      packageCommandRunner: context.packageCommandRunner,
    }),
    installSnapshot,
  );
}

function ensurePackageAvailableResult(
  installAction: "reuse" | "install",
  installedPackage: InstalledNpmWorkflowPackage,
  installSnapshot?: WorkflowPackageInstallSnapshot,
): EnsureNpmWorkflowPackageAvailableResult {
  return {
    installAction,
    installRoot: installedPackage.installRoot,
    packageName: installedPackage.packageName,
    installedPackage,
    ...(installedPackage.resolvedVersion === undefined
      ? {}
      : { resolvedVersion: installedPackage.resolvedVersion }),
    ...(installSnapshot === undefined ? {} : { installSnapshot }),
  };
}

export async function readExistingInstalledNpmWorkflowPackage(
  packageRef: ParsedWorkflowPackageRef,
  scope: WorkflowRegistryScope,
  installRoot: string,
): Promise<InstalledNpmWorkflowPackage | undefined> {
  if (packageRef.sourceType !== "npm") {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(
        join(installRoot, "node_modules", ...packageRef.packageName.split("/"), "package.json"),
        "utf8",
      ),
    ) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const manifest = isRecord(parsed) ? parsed : {};
  const manifestPackageName = manifest.name;
  const packageName =
    typeof manifestPackageName === "string" && manifestPackageName.trim().length > 0
      ? manifestPackageName
      : packageRef.packageName;
  const resolvedVersion = manifest.version;
  return {
    sourceType: "npm",
    packageName,
    requestedSpec: packageRef.requestedSpec,
    requestedRange: packageRef.requestedRange,
    installScope: scope,
    installRoot,
    ...(typeof resolvedVersion === "string" ? { resolvedVersion } : {}),
    installOwnership: "reused-existing",
  };
}

function writeExistingPackageSummary(
  installedPackage: InstalledNpmWorkflowPackage,
  packageRef: ParsedWorkflowPackageRef,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): void {
  const versionSuffix =
    installedPackage.resolvedVersion === undefined ? "" : `@${installedPackage.resolvedVersion}`;
  context.io.writeLine(
    `Package ${installedPackage.packageName}${versionSuffix} is already installed in ${scope} scope.`,
  );
  context.io.writeLine(`Source type: ${installedPackage.sourceType}`);
  context.io.writeLine(`Requested spec: ${packageRef.requestedSpec}`);
  context.io.writeLine(`Install root: ${installedPackage.installRoot}`);
}

function existingPackagePrompt(packageName: string, scope: WorkflowRegistryScope): string {
  return `Package ${packageName} is already installed in ${scope} scope. What should TrailStep do?`;
}

export async function reportPackageAddInstallCleanup(
  preparedSource: Extract<PreparedAddSource, { readonly status: "ready" }>,
  context: CliCommandContext,
): Promise<void> {
  if (preparedSource.installedPackage === undefined) {
    return;
  }

  if (preparedSource.installSnapshot === undefined) {
    context.io.writeError(
      `Cleanup: preserved existing package ${preparedSource.installedPackage.packageName} in ${preparedSource.installedPackage.installScope} scope; no package install rollback was run.`,
    );
    return;
  }

  try {
    await rollbackWorkflowPackageInstall(preparedSource.installSnapshot);
    context.io.writeError(
      `Cleanup: rolled back package install for ${preparedSource.installedPackage.packageName} in ${preparedSource.installedPackage.installScope} scope.`,
    );
  } catch (cleanupError) {
    context.io.writeError(
      `Cleanup failed for package ${preparedSource.installedPackage.packageName} in ${preparedSource.installedPackage.installScope} scope: ${cleanupError instanceof Error ? cleanupError.message : "unknown error"}`,
    );
  }
}

export function attachPackageMetadataToRegistryTargets(
  targets: readonly AddRegistryTarget[],
  installedPackage: InstalledNpmWorkflowPackage | undefined,
): readonly AddRegistryTarget[] {
  if (installedPackage === undefined) {
    return targets;
  }

  return targets.map((target) => ({
    ...target,
    metadata: createPackageRegistryMetadata(target, installedPackage),
  }));
}

function createPackageRegistryMetadata(
  target: AddRegistryTarget,
  installedPackage: InstalledNpmWorkflowPackage,
): WorkflowPackageRegistryMetadata {
  const workflowName = target.bundleSpecifier?.workflowName ?? target.workflow?.id;
  if (workflowName === undefined) {
    throw new WorkflowResolutionError(
      `Unable to determine package workflow metadata for ${target.targetRef}.`,
    );
  }

  return {
    kind: "package",
    sourceType: installedPackage.sourceType,
    packageName: installedPackage.packageName,
    requestedSpec: installedPackage.requestedSpec,
    requestedRange: installedPackage.requestedRange,
    installScope: installedPackage.installScope,
    targetRef: target.targetRef,
    workflowName,
    exportName: target.bundleExportName ?? workflowName,
    ...(installedPackage.resolvedVersion === undefined
      ? {}
      : { resolvedVersion: installedPackage.resolvedVersion }),
    ...(installedPackage.githubRef === undefined ? {} : { githubRef: installedPackage.githubRef }),
    ...(installedPackage.installOwnership === undefined
      ? {}
      : { installOwnership: installedPackage.installOwnership }),
  };
}

export async function validateAndBuildRegistryTargets(
  args: SourceResolutionArgs,
  cwd: string,
  context: CliCommandContext,
): Promise<readonly AddRegistryTarget[]> {
  const candidates = await listAddWorkflowCandidates(args.source, cwd);
  return selectAddWorkflowCandidates(candidates, args, context);
}

async function listAddWorkflowCandidates(
  source: string,
  cwd: string,
): Promise<readonly AddWorkflowCandidate[]> {
  const candidates = (await isBundleSource(source, cwd))
    ? await listBundleAddWorkflowCandidates(source, cwd)
    : await listDirectAddWorkflowCandidates(source, cwd);

  if (candidates.length === 0) {
    throw new WorkflowResolutionError(`No workflows found in ${source}.`);
  }

  return candidates;
}

async function listBundleAddWorkflowCandidates(
  source: string,
  cwd: string,
): Promise<readonly AddWorkflowCandidate[]> {
  const workflowNames = await readBundleWorkflowNames(source, cwd);
  const candidates: AddWorkflowCandidate[] = [];
  const requiresStrictManifestLoading = await hasBundleWorkflowManifest(source, { cwd });

  for (const workflowName of workflowNames) {
    const specifier = bundleWorkflowSpecifier(source, workflowName);
    try {
      const bundleWorkflow = await loadBundleWorkflow(specifier, { cwd });
      candidates.push({
        selectionName: workflowName,
        sourceKind: "bundle",
        targetRef: `${source}#${workflowName}`,
        workflow: bundleWorkflow.workflow as WorkflowSkillMetadata,
        bundleSpecifier: specifier,
        bundleExportName: bundleWorkflow.workflowRef.exportName,
      });
    } catch (error) {
      if (requiresStrictManifestLoading) {
        throw error;
      }
      candidates.push({
        selectionName: workflowName,
        sourceKind: "bundle",
        targetRef: `${source}#${workflowName}`,
        bundleSpecifier: specifier,
        bundleExportName: workflowName,
      });
    }
  }

  return candidates;
}

async function listDirectAddWorkflowCandidates(
  source: string,
  cwd: string,
): Promise<readonly AddWorkflowCandidate[]> {
  const directWorkflowExports = await loadDirectWorkflowExports(source, { cwd });
  return directWorkflowExports.workflows.map((entry) => ({
    selectionName: entry.name,
    sourceKind: "direct",
    targetRef:
      directWorkflowExports.workflows.length === 1 && directWorkflowExports.exportName === undefined
        ? source
        : `${source}#${entry.name}`,
    workflow: entry.workflow as WorkflowSkillMetadata,
  }));
}

async function selectAddWorkflowCandidates(
  candidates: readonly AddWorkflowCandidate[],
  args: SourceResolutionArgs,
  context: CliCommandContext,
): Promise<readonly AddRegistryTarget[]> {
  if (args.workflow !== undefined) {
    return selectCandidatesFromWorkflowFlag(candidates, args.workflow);
  }

  if (args.selectionPolicy === "all") {
    return candidates;
  }

  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (candidate === undefined) {
      throw new CliUsageError(
        `Source ${args.source} contains multiple workflows. Choose one with --workflow <workflow>.`,
      );
    }
    return [candidate];
  }

  const selectedNames = await promptMultiSelect(
    workflowPromptLabel(candidates),
    [SELECT_ALL_WORKFLOWS_CHOICE, ...candidates.map((candidate) => candidate.selectionName)],
    context.prompts,
    `Source ${args.source} contains multiple workflows. Choose one or more with --workflow <workflow>.`,
  );

  if (selectedNames.includes(SELECT_ALL_WORKFLOWS_CHOICE)) {
    return candidates;
  }

  return selectedNames.map((workflowName) => findAddWorkflowCandidate(candidates, workflowName));
}

function selectCandidatesFromWorkflowFlag(
  candidates: readonly AddWorkflowCandidate[],
  workflowFlag: string,
): readonly AddWorkflowCandidate[] {
  if (workflowFlag === "*") {
    return candidates;
  }

  const selectedNames = workflowFlag.split(",").map((part) => part.trim());
  if (selectedNames.some((name) => name.length === 0)) {
    throw new CliUsageError("trailstep add --workflow entries must be non-empty workflow names.");
  }
  const selectedNameSet = new Set(selectedNames);
  if (selectedNameSet.size !== selectedNames.length) {
    throw new CliUsageError("trailstep add --workflow entries must not contain duplicates.");
  }

  for (const selectedName of selectedNames) {
    findAddWorkflowCandidate(candidates, selectedName);
  }

  return candidates.filter((candidate) => selectedNameSet.has(candidate.selectionName));
}

function findAddWorkflowCandidate(
  candidates: readonly AddWorkflowCandidate[],
  workflowName: string,
): AddWorkflowCandidate {
  const candidate = candidates.find((entry) => entry.selectionName === workflowName);
  if (candidate === undefined) {
    throw new WorkflowResolutionError(
      `Workflow not found: ${workflowName}. ${formatAvailableWorkflowCandidates(candidates)}`,
    );
  }

  return candidate;
}

function workflowPromptLabel(candidates: readonly AddWorkflowCandidate[]): string {
  return candidates.every((candidate) => candidate.sourceKind === "bundle")
    ? "Bundle workflow"
    : "Workflow";
}

function formatAvailableWorkflowCandidates(candidates: readonly AddWorkflowCandidate[]): string {
  if (candidates.length === 0) {
    return "Available workflows: none.";
  }
  return `Available workflows: ${candidates.map((candidate) => candidate.selectionName).join(", ")}.`;
}

async function isBundleSource(source: string, cwd: string): Promise<boolean> {
  if (!isDirectWorkflowFileReference(source)) {
    return true;
  }

  const sourcePath = resolve(cwd, source);
  let sourceStats: Awaited<ReturnType<typeof stat>>;
  try {
    sourceStats = await stat(sourcePath);
  } catch {
    return false;
  }

  if (!sourceStats.isDirectory()) {
    return false;
  }

  try {
    const parsed = JSON.parse(
      await readFile(resolve(sourcePath, "package.json"), "utf8"),
    ) as unknown;
    const trailstep = isRecord(parsed) ? parsed.trailstep : undefined;
    return isRecord(trailstep) && isRecord(trailstep.workflows);
  } catch {
    return false;
  }
}

async function readBundleWorkflowNames(source: string, cwd: string): Promise<readonly string[]> {
  return listBundleWorkflowNames(source, { cwd });
}

function bundleWorkflowSpecifier(source: string, workflowName: string): BundleWorkflowSpecifier {
  return { packageName: source, workflowName };
}
