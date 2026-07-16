import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Workflow } from "@stepkit/core";

type PackageJson = {
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
    const packageJsonPath = resolvePackageJson(dependencyName, cwd);
    if (!packageJsonPath) {
      continue;
    }

    const packageJson = await readPackageJson(packageJsonPath);
    if (!isWorkflowPackage(packageJson)) {
      continue;
    }

    const packageName = packageJson.name ?? dependencyName;
    const packageDir = dirname(packageJsonPath);
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

function resolvePackageJson(packageName: string, cwd: string): string | undefined {
  const requireFromCwd = createRequire(join(cwd, "package.json"));

  try {
    return requireFromCwd.resolve(`${packageName}/package.json`);
  } catch {
    return undefined;
  }
}

function isWorkflowPackage(packageJson: PackageJson): boolean {
  return Array.isArray(packageJson.keywords) && packageJson.keywords.includes("stepkit-workflow");
}

async function importPackage(
  packageJsonPath: string,
  packageJson: PackageJson,
): Promise<Record<string, unknown>> {
  const packageRoot = dirname(packageJsonPath);
  const entryPoint = getImportEntryPoint(packageJson);
  const entryPath = join(packageRoot, entryPoint);

  return import(pathToFileURL(entryPath).href) as Promise<Record<string, unknown>>;
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

function isWorkflow(value: unknown): value is Workflow {
  if (!isPlainObject(value)) {
    return false;
  }

  const inputShape = value.inputShape ?? value.input;
  const outputShape = value.outputShape ?? value.output;

  return (
    typeof value.id === "string" &&
    isShapeInput(inputShape) &&
    (outputShape === undefined || isShapeInput(outputShape)) &&
    typeof value.start === "function"
  );
}

function isShapeInput(value: unknown): boolean {
  return isSchemaLike(value) || isSimpleShapeObject(value);
}

function isSchemaLike(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    typeof value.validate === "function" &&
    typeof value.diagnostics === "function" &&
    typeof value.assert === "function"
  );
}

function isSimpleShapeObject(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    Object.values(value).every(
      (shapeType) => shapeType === "string" || shapeType === "number" || shapeType === "boolean",
    )
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
