import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  CliCommandContext,
  PackageCommandRunner,
} from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import {
  createPackageAddCommand,
  defaultPackageCommandRunner,
  detectPackageManager,
  isPnpmWorkspaceRoot,
} from "../../package-manager/package-manager.js";
import { loadProviderPackage } from "../../providers/provider-package-loader.js";
import {
  type ProviderPackageRef,
  parseProviderPackageRef,
} from "../../providers/provider-package-ref.js";
import type { WorkflowRegistryScope } from "../../workflow-registry/workflow-registry.js";

import type {
  LoadedProviderDefinition,
  ProviderManifestWithStoredMetadata,
  TrailStepProviderRegistration,
} from "./providers-command.types.js";
import { parseProviderManifest } from "./providers-manifest.js";
import { isNodeError, isRecord } from "./record-utils.js";

export async function prepareProviderForAdd(
  source: string,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<
  LoadedProviderDefinition & { readonly source: TrailStepProviderRegistration["source"] }
> {
  const packageRef = (await localSourceExists(source, context))
    ? undefined
    : parseProviderPackageRef(source);
  if (packageRef === undefined) {
    const provider = await loadProviderDefinition(source, context);
    return {
      ...provider,
      source: provider.packageName
        ? {
            type: "local-package",
            packageName: provider.packageName,
            spec: source,
            ...(provider.version === undefined ? {} : { resolvedVersion: provider.version }),
          }
        : { type: "local-manifest", path: source },
    };
  }

  const installed = await installProviderPackage(packageRef, scope, context);
  const provider = await loadProviderPackage(installed.packageRoot);
  return {
    ...provider,
    source: {
      type: packageRef.sourceType,
      packageName: installed.packageName,
      spec: source,
      ...(provider.version === undefined ? {} : { resolvedVersion: provider.version }),
    },
  };
}

export async function loadProviderDefinition(
  source: string,
  context: CliCommandContext,
): Promise<LoadedProviderDefinition> {
  const fullPath = resolve(context.cwd, source);
  try {
    if ((await stat(fullPath)).isDirectory()) {
      return loadProviderPackage(fullPath) as Promise<LoadedProviderDefinition>;
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  const manifest = await readLocalManifest(source, context);
  return {
    manifest,
    hooksPresent: isRecord(manifest.hooks) && Object.keys(manifest.hooks).length > 0,
  };
}

export async function inspectInstalledProviderPackage(
  source: string,
  context: CliCommandContext,
): Promise<LoadedProviderDefinition> {
  const packageRef = parseProviderPackageRef(source);
  if (packageRef?.packageName === undefined) {
    throw new CliUsageError(
      "trailstep providers inspect requires a local manifest path, local package directory, or npm package already present in node_modules.",
    );
  }
  const packageRoot = join(context.cwd, "node_modules", ...packageRef.packageName.split("/"));
  try {
    await stat(packageRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new CliUsageError(
        `Provider package ${source} is not installed. Run trailstep providers add ${source} --scope <scope> to install and register it.`,
      );
    }
    throw error;
  }
  return loadProviderPackage(packageRoot) as Promise<LoadedProviderDefinition>;
}

export async function localSourceExists(
  source: string,
  context: CliCommandContext,
): Promise<boolean> {
  try {
    await stat(resolve(context.cwd, source));
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function installProviderPackage(
  packageRef: ProviderPackageRef,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<{ readonly packageRoot: string; readonly packageName: string }> {
  const installRoot =
    scope === "global"
      ? join(context.homeDir ?? context.cwd, ".trailstep", "packages")
      : context.cwd;
  await ensurePackageJsonExists(installRoot);
  const packageManager = await detectPackageManager({ cwd: installRoot });
  const command = createPackageAddCommand({
    packageManager: packageManager.name,
    saveType: "dependencies",
    packageSpec: packageRef.requestedSpec,
    workspaceRoot:
      packageManager.name === "pnpm" ? await isPnpmWorkspaceRoot({ cwd: installRoot }) : false,
  });
  const runner: PackageCommandRunner = context.packageCommandRunner ?? defaultPackageCommandRunner;
  const installedBefore =
    packageRef.packageName === undefined ? await listInstalledPackageNames(installRoot) : [];
  const result = await runner({ command: command.command, args: command.args, cwd: installRoot });
  if (result.exitCode !== 0) {
    throw new CliUsageError(
      `Package install failed for ${packageRef.requestedSpec} with exit code ${result.exitCode}.${result.stderr ? `\n${result.stderr}` : ""}`,
    );
  }
  const packageName =
    packageRef.packageName ??
    (await findInstalledProviderPackageName(installRoot, installedBefore));
  return { packageName, packageRoot: join(installRoot, "node_modules", ...packageName.split("/")) };
}

async function ensurePackageJsonExists(installRoot: string): Promise<void> {
  await mkdir(installRoot, { recursive: true });
  try {
    await readFile(join(installRoot, "package.json"), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      await writeFile(join(installRoot, "package.json"), "{}\n", "utf8");
      return;
    }
    throw error;
  }
}

async function findInstalledProviderPackageName(
  installRoot: string,
  installedBefore: readonly string[],
): Promise<string> {
  const before = new Set(installedBefore);
  const installedAfter = await listInstalledPackageNames(installRoot);
  const added = installedAfter.filter((packageName) => !before.has(packageName));
  if (added.length === 1 && added[0] !== undefined) return added[0];
  if (installedAfter.length === 1 && installedAfter[0] !== undefined) return installedAfter[0];
  throw new CliUsageError(
    "Package install completed but provider package name could not be identified.",
  );
}

async function listInstalledPackageNames(installRoot: string): Promise<readonly string[]> {
  const root = join(installRoot, "node_modules");
  let entries: Array<{ readonly name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const packages: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const scopedEntry of await readdir(join(root, entry.name), { withFileTypes: true })) {
        if (scopedEntry.isDirectory() && !scopedEntry.name.startsWith(".")) {
          packages.push(`${entry.name}/${scopedEntry.name}`);
        }
      }
      continue;
    }
    packages.push(entry.name);
  }
  return packages;
}

export async function readLocalManifest(
  manifestPath: string,
  context: CliCommandContext,
): Promise<ProviderManifestWithStoredMetadata> {
  const fullPath = resolve(context.cwd, manifestPath);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(fullPath, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliUsageError(
        `Invalid provider manifest JSON at ${manifestPath}: ${error.message}`,
      );
    }
    throw error;
  }

  const diagnostics: string[] = [];
  const manifest = parseProviderManifest("manifest", value, diagnostics);
  if (manifest === undefined || diagnostics.length > 0) {
    throw new CliUsageError(
      `Invalid provider manifest at ${manifestPath}:\n${diagnostics.join("\n")}`,
    );
  }
  return isRecord(value) && isRecord(value.hooks) ? { ...manifest, hooks: value.hooks } : manifest;
}
