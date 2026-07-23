import { accessSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Workflow } from "@stepkit/core";

import { isWorkflow } from "../workflow-resolution/workflow-validator.js";

export type PackageJson = {
  name?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  keywords?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export interface DiscoveredWorkflow {
  readonly id: string;
  readonly packageName: string;
  readonly packageDir: string;
  readonly exportName: string;
  readonly workflow: Workflow;
}

export interface InstalledPackageManifest {
  readonly packageJsonPath: string;
  readonly packageDir: string;
  readonly packageJson: PackageJson & Record<string, unknown>;
}

export interface DiscoverWorkflowsOptions {
  readonly cwd?: string;
}

export async function discoverWorkflows(
  options: DiscoverWorkflowsOptions = {},
): Promise<DiscoveredWorkflow[]> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const consumerPackageJson = await readPackageJson(join(cwd, "package.json"));
  const dependencyNames = Object.keys({
    ...consumerPackageJson.dependencies,
    ...consumerPackageJson.devDependencies,
  }).sort();
  const discovered: DiscoveredWorkflow[] = [];

  for (const dependencyName of dependencyNames) {
    const manifest = await resolveInstalledPackageManifest(dependencyName, cwd);
    if (!manifest || !isWorkflowPackage(manifest.packageJson)) {
      continue;
    }

    const { packageJsonPath, packageDir, packageJson } = manifest;
    const packageName = packageJson.name ?? dependencyName;
    const packageModule = await importPackage(packageJsonPath, packageJson);

    for (const [exportName, exportedValue] of Object.entries(packageModule)) {
      if (exportName === "default" || !isWorkflow(exportedValue)) {
        continue;
      }

      discovered.push({
        id: `${packageName}:${exportName}`,
        packageName,
        packageDir,
        exportName,
        workflow: exportedValue,
      });
    }
  }

  return discovered;
}

async function readPackageJson(path: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path, "utf8")) as PackageJson;
}

export async function resolveInstalledPackageManifest(
  packageName: string,
  cwd: string,
): Promise<InstalledPackageManifest | undefined> {
  const packageJsonPath = resolvePackageJson(packageName, cwd);
  if (packageJsonPath === undefined) {
    return undefined;
  }

  try {
    return {
      packageJsonPath,
      packageDir: dirname(packageJsonPath),
      packageJson: (await readPackageJson(packageJsonPath)) as PackageJson &
        Record<string, unknown>,
    };
  } catch {
    return undefined;
  }
}

function resolvePackageJson(packageName: string, cwd: string): string | undefined {
  const requireFromCwd = createRequire(resolve(cwd, "package.json"));

  try {
    return requireFromCwd.resolve(`${packageName}/package.json`);
  } catch {
    try {
      return findPackageJson(dirname(requireFromCwd.resolve(packageName)));
    } catch {
      const conventionalPackageJson = join(
        cwd,
        "node_modules",
        ...packageName.split("/"),
        "package.json",
      );
      try {
        accessSync(conventionalPackageJson);
        return conventionalPackageJson;
      } catch {
        return undefined;
      }
    }
  }
}

function findPackageJson(startDir: string): string | undefined {
  let currentDir = resolve(startDir);
  while (true) {
    const candidate = join(currentDir, "package.json");
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) {
        return undefined;
      }
      currentDir = parentDir;
    }
  }
}

function isWorkflowPackage(packageJson: PackageJson): boolean {
  return Array.isArray(packageJson.keywords) && packageJson.keywords.includes("stepkit-workflow");
}

async function importPackage(
  packageJsonPath: string,
  packageJson: PackageJson,
): Promise<Record<string, unknown>> {
  const entryPath = resolvePackageEntryFilePath(packageJson, dirname(packageJsonPath));

  return import(pathToFileURL(entryPath).href) as Promise<Record<string, unknown>>;
}

export function resolvePackageEntryFilePath(packageJson: PackageJson, packageDir: string): string {
  return resolve(packageDir, getImportEntryPoint(packageJson));
}

function getImportEntryPoint(packageJson: PackageJson): string {
  if (typeof packageJson.exports === "string") {
    return packageJson.exports;
  }

  if (isPlainObject(packageJson.exports)) {
    const rootExport = packageJson.exports["."];
    if (typeof rootExport === "string") {
      return rootExport;
    }
    if (isPlainObject(rootExport)) {
      const importExport = rootExport.import;
      if (typeof importExport === "string") {
        return importExport;
      }
    }
  }

  return packageJson.module ?? packageJson.main ?? "./index.js";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
