import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PackageCommandRunner } from "../command.types.js";
import { defaultPackageCommandRunner } from "../package-manager/package-manager.js";
import type {
  WorkflowRegistryContext,
  WorkflowRegistryScope,
} from "../workflow-registry/workflow-registry.js";
import {
  workflowPackageInstallRootForScope,
  workflowPackageInstallSaveArgsForScope,
} from "./install-root.js";
import type { ParsedNpmPackageRef } from "./package-ref.js";

export interface InstalledNpmWorkflowPackage {
  readonly sourceType: "npm";
  readonly packageName: string;
  readonly requestedSpec: string;
  readonly requestedRange: string;
  readonly installScope: WorkflowRegistryScope;
  readonly installRoot: string;
  readonly resolvedVersion?: string;
}

export interface InstallNpmWorkflowPackageOptions extends WorkflowRegistryContext {
  readonly packageRef: ParsedNpmPackageRef;
  readonly scope: WorkflowRegistryScope;
  readonly packageCommandRunner?: PackageCommandRunner;
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

  const installResult = await packageCommandRunner({
    command: "npm",
    args: ["install", ...workflowPackageInstallSaveArgsForScope(scope), packageRef.requestedSpec],
    cwd: installRoot,
  });
  if (installResult.exitCode !== 0) {
    throw new WorkflowPackageInstallError(
      [
        `npm install failed for ${packageRef.requestedSpec} with exit code ${installResult.exitCode}.`,
        installResult.stderr,
      ]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join("\n"),
    );
  }

  const installedManifest = await readInstalledPackageManifest(installRoot, packageRef.packageName);
  return {
    sourceType: "npm",
    packageName: packageRef.packageName,
    requestedSpec: packageRef.requestedSpec,
    requestedRange: packageRef.requestedRange,
    installScope: scope,
    installRoot,
    ...(typeof installedManifest.version === "string"
      ? { resolvedVersion: installedManifest.version }
      : {}),
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

function isNodeError(error: unknown): error is { readonly code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
