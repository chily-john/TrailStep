import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { listRegisteredWorkflowEntries } from "../workflow-registry/workflow-registry.js";
import { isDirectWorkflowFileReference } from "../workflow-resolution/workflow-resolution.js";

export interface DeprecationScanTarget {
  readonly sourceFile: string;
}

export interface ResolveDeprecationScanTargetsOptions {
  readonly cwd: string;
  readonly homeDir?: string;
  readonly includeDiscovered?: boolean;
  readonly packageNames?: readonly string[];
}

export async function resolveDeprecationScanTargets({
  cwd,
  homeDir,
  includeDiscovered = false,
  packageNames,
}: ResolveDeprecationScanTargetsOptions): Promise<readonly DeprecationScanTarget[]> {
  const sourceFiles = new Set<string>();
  const registeredEntries = await listRegisteredWorkflowEntries({ cwd, homeDir });

  for (const entry of registeredEntries) {
    await addSourceFilesForTarget(sourceFiles, entry.targetRef, entry.name, cwd, packageNames);
  }

  if (includeDiscovered) {
    for (const packageName of await discoverWorkflowPackageNames(cwd)) {
      if (packageNames && !packageNames.includes(packageName)) {
        continue;
      }
      await addPackageSourceFile(sourceFiles, packageName, undefined, cwd);
    }
  }

  return [...sourceFiles].map((sourceFile) => ({ sourceFile }));
}

async function addSourceFilesForTarget(
  sourceFiles: Set<string>,
  targetRef: string,
  workflowName: string,
  cwd: string,
  packageNames: readonly string[] | undefined,
): Promise<void> {
  if (
    isDirectWorkflowFileReference(targetRef) ||
    targetRef === "~" ||
    targetRef.startsWith("~/") ||
    targetRef.startsWith("~\\")
  ) {
    // Direct-file registered workflows have no npm version — there is nothing to update, and
    // therefore nothing meaningful to scan for deprecated @stepkit/core/@stepkit/sdk symbol usage
    // triggered by a package version bump. Exclude them from scan targets entirely.
    return;
  }

  const [packageName, bundleWorkflowName] = splitBundleTarget(targetRef, workflowName);
  if (packageNames && !packageNames.includes(packageName)) {
    return;
  }
  await addPackageSourceFile(sourceFiles, packageName, bundleWorkflowName, cwd);
}

async function addPackageSourceFile(
  sourceFiles: Set<string>,
  packageName: string,
  workflowName: string | undefined,
  cwd: string,
): Promise<void> {
  const packageDir = join(cwd, "node_modules", ...packageName.split("/"));
  const packageJsonPath = join(packageDir, "package.json");
  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }

  const manifestTarget = readBundleManifestTarget(packageJson, workflowName);
  const relativeSource =
    manifestTarget ?? (typeof packageJson.main === "string" ? packageJson.main : "index.js");
  sourceFiles.add(resolve(packageDir, stripExportSuffix(relativeSource)));
}

function readBundleManifestTarget(
  packageJson: Record<string, unknown>,
  workflowName: string | undefined,
): string | undefined {
  const stepkit = packageJson.stepkit;
  if (!isRecord(stepkit) || !isRecord(stepkit.workflows)) {
    return undefined;
  }
  const workflows = stepkit.workflows;
  const target = workflowName === undefined ? Object.values(workflows)[0] : workflows[workflowName];
  return typeof target === "string" ? target : undefined;
}

async function discoverWorkflowPackageNames(cwd: string): Promise<readonly string[]> {
  const packages: string[] = [];
  const nodeModules = join(cwd, "node_modules");
  let entries: string[];
  try {
    entries = await readdir(nodeModules);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.startsWith("@")) {
      for (const scopedEntry of await readdir(join(nodeModules, entry)).catch(() => [])) {
        await addIfWorkflowPackage(packages, `${entry}/${scopedEntry}`, cwd);
      }
    } else {
      await addIfWorkflowPackage(packages, entry, cwd);
    }
  }
  return packages;
}

async function addIfWorkflowPackage(
  packages: string[],
  packageName: string,
  cwd: string,
): Promise<void> {
  try {
    const packageJson = JSON.parse(
      await readFile(join(cwd, "node_modules", ...packageName.split("/"), "package.json"), "utf8"),
    ) as Record<string, unknown>;
    if (Array.isArray(packageJson.keywords) && packageJson.keywords.includes("stepkit-workflow")) {
      packages.push(packageName);
    }
  } catch {
    // Ignore unreadable packages during preflight target discovery.
  }
}

function splitBundleTarget(
  targetRef: string,
  defaultWorkflowName: string,
): readonly [string, string | undefined] {
  const hashIndex = targetRef.indexOf("#");
  if (hashIndex > 0) {
    return [targetRef.slice(0, hashIndex), targetRef.slice(hashIndex + 1)];
  }
  const legacyIndex = targetRef.lastIndexOf(":");
  if (legacyIndex > 0) {
    return [targetRef.slice(0, legacyIndex), defaultWorkflowName];
  }
  return [targetRef, undefined];
}

function stripExportSuffix(ref: string): string {
  return ref.split("#")[0] ?? ref;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
