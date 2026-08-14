import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PackageCommandRunner } from "../command.types.js";
import {
  createPackageAddCommand,
  defaultPackageCommandRunner,
  detectPackageManager,
  isPnpmWorkspaceRoot,
} from "../package-manager/package-manager.js";
import type {
  WorkflowPackageInstallOwnership,
  WorkflowRegistryContext,
  WorkflowRegistryScope,
} from "../workflow-registry/workflow-registry.js";
import { workflowPackageInstallRootForScope } from "./install-root.js";
import type { ParsedWorkflowPackageRef } from "./package-ref.js";

export interface InstalledNpmWorkflowPackage {
  readonly sourceType: "npm" | "github";
  readonly packageName: string;
  readonly requestedSpec: string;
  readonly requestedRange: string;
  readonly installScope: WorkflowRegistryScope;
  readonly installRoot: string;
  readonly resolvedVersion?: string;
  readonly githubRef?: string;
  readonly installOwnership?: WorkflowPackageInstallOwnership;
}

export interface InstallNpmWorkflowPackageOptions extends WorkflowRegistryContext {
  readonly packageRef: ParsedWorkflowPackageRef;
  readonly scope: WorkflowRegistryScope;
  readonly packageCommandRunner?: PackageCommandRunner;
}

interface InstalledPackageManifestCandidate {
  readonly packageName: string;
  readonly manifest: Record<string, unknown>;
}

export class WorkflowPackageInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowPackageInstallError";
  }
}

export async function installNpmWorkflowPackage({
  packageRef,
  scope,
  cwd,
  homeDir,
  packageCommandRunner = defaultPackageCommandRunner,
}: InstallNpmWorkflowPackageOptions): Promise<InstalledNpmWorkflowPackage> {
  const installRoot = workflowPackageInstallRootForScope(scope, { cwd, homeDir });
  await ensurePackageJsonExists(installRoot);
  const previousPackageNames =
    packageRef.sourceType === "github"
      ? await listInstalledPackageNames(installRoot)
      : new Set<string>();

  const packageManager = await detectPackageManager({ cwd: installRoot });
  const installCommand = createPackageAddCommand({
    packageManager: packageManager.name,
    saveType: workflowPackageInstallSaveTypeForScope(scope),
    packageSpec: packageRef.requestedSpec,
    workspaceRoot:
      packageManager.name === "pnpm" ? await isPnpmWorkspaceRoot({ cwd: installRoot }) : false,
  });
  const installResult = await packageCommandRunner({
    command: installCommand.command,
    args: installCommand.args,
    cwd: installRoot,
  });
  if (installResult.exitCode !== 0) {
    throw new WorkflowPackageInstallError(
      [
        `${formatPackageCommand(installCommand)} failed for ${packageRef.requestedSpec} with exit code ${installResult.exitCode}.`,
        installResult.stderr,
      ]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join("\n"),
    );
  }

  const installedManifest = await readInstalledPackageManifestForRef(
    installRoot,
    packageRef,
    previousPackageNames,
  );
  const packageName = readInstalledPackageName(
    installedManifest,
    packageRef.sourceType === "npm" ? packageRef.packageName : undefined,
    packageRef.requestedSpec,
  );

  return {
    sourceType: packageRef.sourceType,
    packageName,
    requestedSpec: packageRef.requestedSpec,
    requestedRange: packageRef.requestedRange,
    installScope: scope,
    installRoot,
    ...(typeof installedManifest.version === "string"
      ? { resolvedVersion: installedManifest.version }
      : {}),
    ...(packageRef.sourceType === "github" ? { githubRef: packageRef.githubRef } : {}),
    installOwnership: "trailstep-installed",
  };
}

async function ensurePackageJsonExists(installRoot: string): Promise<void> {
  const packageJsonPath = join(installRoot, "package.json");
  try {
    await readFile(packageJsonPath, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    await mkdir(installRoot, { recursive: true });
    await writeFile(packageJsonPath, "{}\n", "utf8");
  }
}

async function readInstalledPackageManifestForRef(
  installRoot: string,
  packageRef: ParsedWorkflowPackageRef,
  previousPackageNames: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
  if (packageRef.sourceType === "npm") {
    return readInstalledPackageManifest(installRoot, packageRef.packageName);
  }

  const dependencyPackageName = await readDependencyPackageNameForRequestedSpec(
    installRoot,
    packageRef.requestedSpec,
  );
  if (dependencyPackageName !== undefined) {
    return readInstalledPackageManifest(installRoot, dependencyPackageName);
  }

  const candidates = await readInstalledPackageManifestCandidates(installRoot);
  const newCandidates = candidates.filter(
    (candidate) => !previousPackageNames.has(candidate.packageName),
  );
  const newWorkflowCandidates = newCandidates.filter((candidate) =>
    hasTrailStepWorkflowManifest(candidate.manifest),
  );
  if (newWorkflowCandidates.length === 1) {
    const candidate = newWorkflowCandidates[0];
    if (candidate !== undefined) {
      return candidate.manifest;
    }
  }
  if (newCandidates.length === 1) {
    const candidate = newCandidates[0];
    if (candidate !== undefined) {
      return candidate.manifest;
    }
  }

  const allWorkflowCandidates = candidates.filter((candidate) =>
    hasTrailStepWorkflowManifest(candidate.manifest),
  );
  if (allWorkflowCandidates.length === 1) {
    const candidate = allWorkflowCandidates[0];
    if (candidate !== undefined) {
      return candidate.manifest;
    }
  }

  throw new WorkflowPackageInstallError(
    candidates.length === 0
      ? `npm install completed but installed GitHub package manifest was not found for ${packageRef.requestedSpec}.`
      : `npm install completed but installed GitHub package for ${packageRef.requestedSpec} could not be identified. Ensure package.json records a dependency for ${packageRef.requestedSpec}.`,
  );
}

async function readDependencyPackageNameForRequestedSpec(
  installRoot: string,
  requestedSpec: string,
): Promise<string | undefined> {
  const rootPackageJson = await readJsonObject(join(installRoot, "package.json"));
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const dependencies = rootPackageJson[section];
    if (!isRecord(dependencies)) {
      continue;
    }
    for (const [packageName, range] of Object.entries(dependencies)) {
      if (range === requestedSpec) {
        return packageName;
      }
    }
  }
  return undefined;
}

async function readInstalledPackageManifest(
  installRoot: string,
  packageName: string,
): Promise<Record<string, unknown>> {
  const packageJsonPath = join(
    installRoot,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new WorkflowPackageInstallError(
        `npm install completed but installed package manifest was not found: ${packageJsonPath}`,
      );
    }
    throw error;
  }
}

async function listInstalledPackageNames(installRoot: string): Promise<ReadonlySet<string>> {
  return new Set(
    (await readInstalledPackageManifestCandidates(installRoot)).map(
      (candidate) => candidate.packageName,
    ),
  );
}

async function readInstalledPackageManifestCandidates(
  installRoot: string,
): Promise<readonly InstalledPackageManifestCandidate[]> {
  const nodeModulesDir = join(installRoot, "node_modules");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(nodeModulesDir, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const candidates: InstalledPackageManifestCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    if (entry.name.startsWith("@")) {
      candidates.push(...(await readScopedPackageManifestCandidates(nodeModulesDir, entry.name)));
      continue;
    }

    const candidate = await readPackageManifestCandidate(
      join(nodeModulesDir, entry.name, "package.json"),
      entry.name,
    );
    if (candidate !== undefined) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

async function readScopedPackageManifestCandidates(
  nodeModulesDir: string,
  scopeName: string,
): Promise<readonly InstalledPackageManifestCandidate[]> {
  const scopeDir = join(nodeModulesDir, scopeName);
  let entries: Dirent<string>[];
  try {
    entries = await readdir(scopeDir, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const candidates: InstalledPackageManifestCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const packageName = `${scopeName}/${entry.name}`;
    const candidate = await readPackageManifestCandidate(
      join(scopeDir, entry.name, "package.json"),
      packageName,
    );
    if (candidate !== undefined) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

async function readPackageManifestCandidate(
  packageJsonPath: string,
  packageName: string,
): Promise<InstalledPackageManifestCandidate | undefined> {
  try {
    const manifest = await readJsonObject(packageJsonPath);
    return { packageName, manifest };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function workflowPackageInstallSaveTypeForScope(
  scope: WorkflowRegistryScope,
): "dependencies" | "devDependencies" {
  return scope === "global" ? "dependencies" : "devDependencies";
}

function formatPackageCommand(command: { command: string; args: readonly string[] }): string {
  return [command.command, ...command.args].join(" ");
}

function readInstalledPackageName(
  manifest: Record<string, unknown>,
  fallbackPackageName: string | undefined,
  requestedSpec: string,
): string {
  if (typeof manifest.name === "string" && manifest.name.trim().length > 0) {
    return manifest.name;
  }
  if (fallbackPackageName !== undefined) {
    return fallbackPackageName;
  }
  throw new WorkflowPackageInstallError(
    `npm install completed but installed package manifest for ${requestedSpec} does not declare a package name.`,
  );
}

function hasTrailStepWorkflowManifest(manifest: Record<string, unknown>): boolean {
  const trailstep = manifest.trailstep;
  return isRecord(trailstep) && isRecord(trailstep.workflows);
}

function isNodeError(error: unknown): error is { readonly code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
