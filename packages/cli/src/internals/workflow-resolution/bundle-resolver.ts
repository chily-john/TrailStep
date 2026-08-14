import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Workflow } from "@trailstep/core";

import type { BundleWorkflowReference } from "../workflow-reference/workflow-reference.types.js";
import { listDirectWorkflowExports } from "./direct-file-resolver.js";
import { WorkflowResolutionError } from "./workflow-resolution-error.js";
import { isWorkflow } from "./workflow-validator.js";

export interface LoadBundleWorkflowOptions {
  readonly cwd: string;
  readonly freshImport?: boolean;
}

export interface BundleWorkflowSpecifier {
  readonly packageName: string;
  readonly workflowName: string;
}

export interface ResolvedBundleWorkflow {
  readonly id: string;
  readonly workflow: Workflow;
  readonly workflowRef: BundleWorkflowReference;
}

interface PackageRootWorkflowExport {
  readonly name: string;
  readonly workflow: Workflow;
}

let freshImportCounter = 0;

export async function loadBundleWorkflow(
  specifier: BundleWorkflowSpecifier,
  options: LoadBundleWorkflowOptions,
): Promise<ResolvedBundleWorkflow> {
  const packageJsonPath = resolvePackageJsonPath(specifier.packageName, options.cwd);
  const packageDir = dirname(packageJsonPath);
  const packageJson = await readPackageJson(packageJsonPath, specifier.packageName);
  const workflows = readOptionalBundleWorkflowManifest(packageJson, specifier.packageName);
  if (workflows === undefined) {
    return loadPackageRootBundleWorkflow(specifier, options, packageJson, packageDir);
  }
  const target = workflows[specifier.workflowName];

  if (target === undefined) {
    throw new WorkflowResolutionError(
      `Bundle manifest workflow key not found: ${specifier.workflowName} in ${specifier.packageName}`,
    );
  }

  const parsedTarget = parseManifestTarget(target, specifier.packageName, specifier.workflowName);
  const modulePath = resolve(packageDir, parsedTarget.modulePath);
  let workflowModule: Record<string, unknown>;

  try {
    workflowModule = (await importFileUrl(modulePath, options)) as Record<string, unknown>;
  } catch (error) {
    throw new WorkflowResolutionError(
      `Unable to import bundle workflow module: ${modulePath} from ${specifier.packageName}#${specifier.workflowName}`,
      { cause: error },
    );
  }

  const workflow = workflowModule[parsedTarget.exportName];
  if (!isWorkflow(workflow)) {
    throw new WorkflowResolutionError(
      `Invalid workflow export ${parsedTarget.exportName} in bundle manifest target ${target} for ${specifier.packageName}#${specifier.workflowName}`,
    );
  }

  return createResolvedBundleWorkflow(specifier, workflow, parsedTarget.exportName);
}

export async function hasBundleWorkflowManifest(
  packageName: string,
  options: LoadBundleWorkflowOptions,
): Promise<boolean> {
  try {
    const packageJsonPath = resolvePackageJsonPath(packageName, options.cwd);
    const packageJson = await readPackageJson(packageJsonPath, packageName);
    return readOptionalBundleWorkflowManifest(packageJson, packageName) !== undefined;
  } catch {
    return false;
  }
}

export async function listBundleWorkflowNames(
  packageName: string,
  options: LoadBundleWorkflowOptions,
): Promise<readonly string[]> {
  const packageJsonPath = resolvePackageJsonPath(packageName, options.cwd);
  const packageJson = await readPackageJson(packageJsonPath, packageName);
  const workflows = readOptionalBundleWorkflowManifest(packageJson, packageName);
  if (workflows !== undefined) {
    return Object.keys(workflows);
  }

  try {
    return (
      await listPackageRootWorkflowExports(packageName, options, packageJson, dirname(packageJsonPath))
    ).map((entry) => entry.name);
  } catch (error) {
    const staticWorkflowNames = await listStaticPackageRootWorkflowExportNames(
      packageJson,
      dirname(packageJsonPath),
      packageName,
    );
    if (staticWorkflowNames.length > 0) {
      return staticWorkflowNames;
    }
    throw error;
  }
}

export function resolvePackageJsonPath(packageName: string, cwd: string): string {
  if (isLocalPackageReference(packageName)) {
    return resolve(cwd, packageName, "package.json");
  }

  const nodeModulesPackageJsonPath = resolveNodeModulesPackageJsonPath(packageName, cwd);
  if (nodeModulesPackageJsonPath !== undefined && existsSync(nodeModulesPackageJsonPath)) {
    return nodeModulesPackageJsonPath;
  }

  try {
    return createRequire(resolve(cwd, "package.json")).resolve(`${packageName}/package.json`);
  } catch (error) {
    throw new WorkflowResolutionError(`Bundle package not found: ${packageName}`, { cause: error });
  }
}

function resolveNodeModulesPackageJsonPath(packageName: string, cwd: string): string | undefined {
  const parts = packageName.split("/");
  if (packageName.startsWith("@")) {
    if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
      return undefined;
    }
  } else if (parts.length !== 1 || parts[0]?.length === 0) {
    return undefined;
  }

  return resolve(cwd, "node_modules", ...parts, "package.json");
}

function isLocalPackageReference(packageName: string): boolean {
  return (
    packageName.startsWith("./") ||
    packageName.startsWith("../") ||
    packageName.startsWith(".\\") ||
    packageName.startsWith("..\\") ||
    isAbsolute(packageName) ||
    /^[A-Za-z]:[\\/]/u.test(packageName)
  );
}

async function readPackageJson(path: string, packageName: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new WorkflowResolutionError(
      `Unable to read bundle package manifest for ${packageName}: ${path}`,
      {
        cause: error,
      },
    );
  }
}

async function loadPackageRootBundleWorkflow(
  specifier: BundleWorkflowSpecifier,
  options: LoadBundleWorkflowOptions,
  packageJson: unknown,
  packageDir: string,
): Promise<ResolvedBundleWorkflow> {
  const workflowExports = await listPackageRootWorkflowExports(
    specifier.packageName,
    options,
    packageJson,
    packageDir,
  );
  const workflowExport = workflowExports.find((entry) => entry.name === specifier.workflowName);
  if (workflowExport === undefined) {
    throw new WorkflowResolutionError(
      `Bundle package root workflow export not found: ${specifier.workflowName} in ${specifier.packageName}. ${formatAvailablePackageRootWorkflowExports(workflowExports)}`,
    );
  }

  return createResolvedBundleWorkflow(specifier, workflowExport.workflow, workflowExport.name);
}

async function listPackageRootWorkflowExports(
  packageName: string,
  options: LoadBundleWorkflowOptions,
  packageJson: unknown,
  packageDir: string,
): Promise<readonly PackageRootWorkflowExport[]> {
  const entrypointPath = resolvePackageEntrypointPath(packageJson, packageDir, packageName);
  let workflowModule: Record<string, unknown>;
  try {
    workflowModule = (await importFileUrl(entrypointPath, options)) as Record<string, unknown>;
  } catch (error) {
    throw new WorkflowResolutionError(
      `Unable to import bundle package entrypoint: ${entrypointPath} from ${packageName}`,
      { cause: error },
    );
  }

  const workflowExports = listDirectWorkflowExports(workflowModule);
  if (workflowExports.length === 0) {
    throw new WorkflowResolutionError(
      `Missing trailstep.workflows manifest metadata in bundle package: ${packageName}`,
    );
  }

  return workflowExports;
}

async function listStaticPackageRootWorkflowExportNames(
  packageJson: unknown,
  packageDir: string,
  packageName: string,
): Promise<readonly string[]> {
  const entrypointPath = resolvePackageEntrypointPath(packageJson, packageDir, packageName);
  const source = await readFile(entrypointPath, "utf8");
  return parseStaticEsmExportNames(source);
}

function parseStaticEsmExportNames(source: string): readonly string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/export\s*\{(?<exports>[^}]+)\}/gu)) {
    const exportsSource = match.groups?.exports;
    if (exportsSource === undefined) {
      continue;
    }
    for (const entry of exportsSource.split(",")) {
      const exportName = parseStaticExportListEntry(entry);
      if (exportName !== undefined) {
        names.add(exportName);
      }
    }
  }

  for (const match of source.matchAll(
    /export\s+(?:const|let|var|function|class)\s+(?<name>[A-Za-z_$][\w$]*)/gu,
  )) {
    const name = match.groups?.name;
    if (name !== undefined) {
      names.add(name);
    }
  }

  return [...names].sort((left, right) => left.localeCompare(right));
}

function parseStaticExportListEntry(entry: string): string | undefined {
  const trimmed = entry.trim();
  if (trimmed.length === 0 || trimmed.startsWith("type ")) {
    return undefined;
  }

  const aliasMatch = /\bas\s+(?<alias>[A-Za-z_$][\w$]*)$/u.exec(trimmed);
  if (aliasMatch?.groups?.alias !== undefined) {
    return aliasMatch.groups.alias;
  }

  const nameMatch = /^(?<name>[A-Za-z_$][\w$]*)$/u.exec(trimmed);
  return nameMatch?.groups?.name;
}

function resolvePackageEntrypointPath(
  packageJson: unknown,
  packageDir: string,
  packageName: string,
): string {
  if (!isPlainObject(packageJson)) {
    throw new WorkflowResolutionError(
      `Invalid package manifest for bundle package: ${packageName}`,
    );
  }

  const exportedEntrypoint = readPackageExportEntrypoint(packageJson.exports);
  if (exportedEntrypoint !== undefined) {
    return resolvePackageRelativeEntrypoint(exportedEntrypoint, packageDir, packageName);
  }

  if (typeof packageJson.main === "string") {
    return resolvePackageRelativeEntrypoint(packageJson.main, packageDir, packageName);
  }

  throw new WorkflowResolutionError(
    `Missing trailstep.workflows manifest metadata in bundle package: ${packageName}`,
  );
}

function readPackageExportEntrypoint(exportsValue: unknown): string | undefined {
  if (typeof exportsValue === "string") {
    return exportsValue;
  }
  if (!isPlainObject(exportsValue)) {
    return undefined;
  }

  const dotExport = exportsValue["."];
  if (dotExport !== undefined) {
    return readPackageExportTarget(dotExport);
  }

  const keys = Object.keys(exportsValue);
  if (keys.some((key) => key.startsWith("."))) {
    return undefined;
  }

  return readPackageExportTarget(exportsValue);
}

function readPackageExportTarget(target: unknown): string | undefined {
  if (typeof target === "string") {
    return target;
  }
  if (!isPlainObject(target)) {
    return undefined;
  }

  for (const condition of ["import", "default", "node"] as const) {
    const conditionTarget = readPackageExportTarget(target[condition]);
    if (conditionTarget !== undefined) {
      return conditionTarget;
    }
  }

  return undefined;
}

function resolvePackageRelativeEntrypoint(
  entrypoint: string,
  packageDir: string,
  packageName: string,
): string {
  if (isAbsolute(entrypoint) || !entrypoint.startsWith(".")) {
    throw new WorkflowResolutionError(
      `Invalid package entrypoint for bundle package ${packageName}: expected a relative path.`,
    );
  }

  return resolve(packageDir, entrypoint);
}

async function importFileUrl(path: string, options: LoadBundleWorkflowOptions): Promise<unknown> {
  const moduleUrl = pathToFileURL(path);
  if (options.freshImport === true) {
    freshImportCounter += 1;
    moduleUrl.searchParams.set("trailstepImport", `${freshImportCounter}`);
  }
  return import(moduleUrl.href);
}

function createResolvedBundleWorkflow(
  specifier: BundleWorkflowSpecifier,
  workflow: Workflow,
  exportName: string,
): ResolvedBundleWorkflow {
  return {
    id: `${specifier.packageName}#${specifier.workflowName}`,
    workflow,
    workflowRef: {
      kind: "bundle",
      packageName: specifier.packageName,
      workflowName: specifier.workflowName,
      exportName,
    },
  };
}

function formatAvailablePackageRootWorkflowExports(
  workflowExports: readonly PackageRootWorkflowExport[],
): string {
  if (workflowExports.length === 0) {
    return "Available workflow exports: none.";
  }

  return `Available workflow exports: ${workflowExports.map((entry) => entry.name).join(", ")}.`;
}

export function readBundleWorkflowManifest(
  packageJson: unknown,
  packageName: string,
): Record<string, string> {
  const workflows = readOptionalBundleWorkflowManifest(packageJson, packageName);
  if (workflows === undefined) {
    throw new WorkflowResolutionError(
      `Missing trailstep.workflows manifest metadata in bundle package: ${packageName}`,
    );
  }
  return workflows;
}

function readOptionalBundleWorkflowManifest(
  packageJson: unknown,
  packageName: string,
): Record<string, string> | undefined {
  if (!isPlainObject(packageJson)) {
    throw new WorkflowResolutionError(
      `Invalid package manifest for bundle package: ${packageName}`,
    );
  }

  const trailstep = packageJson.trailstep;
  if (trailstep === undefined) {
    return undefined;
  }
  if (!isPlainObject(trailstep) || !isPlainObject(trailstep.workflows)) {
    throw new WorkflowResolutionError(
      `Missing trailstep.workflows manifest metadata in bundle package: ${packageName}`,
    );
  }

  const workflows = trailstep.workflows;
  if (!Object.values(workflows).every((target) => typeof target === "string")) {
    throw new WorkflowResolutionError(
      `Invalid trailstep.workflows manifest metadata in bundle package: ${packageName}`,
    );
  }

  return workflows as Record<string, string>;
}

export interface ParsedManifestTarget {
  readonly modulePath: string;
  readonly exportName: string;
}

export function parseManifestTarget(
  target: string,
  packageName: string,
  workflowName: string,
): ParsedManifestTarget {
  const separatorIndex = target.lastIndexOf("#");
  if (separatorIndex <= 0 || separatorIndex === target.length - 1) {
    throw new WorkflowResolutionError(
      `Invalid bundle manifest target for ${packageName}#${workflowName}: expected <relative-module-path>#<exportName>.`,
    );
  }

  const modulePath = target.slice(0, separatorIndex);
  if (isAbsolute(modulePath) || !modulePath.startsWith(".")) {
    throw new WorkflowResolutionError(
      `Invalid bundle manifest target for ${packageName}#${workflowName}: expected <relative-module-path>#<exportName>.`,
    );
  }

  return { modulePath, exportName: target.slice(separatorIndex + 1) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
