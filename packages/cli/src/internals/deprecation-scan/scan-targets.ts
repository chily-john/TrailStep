import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import {
  discoverWorkflows,
  type InstalledPackageManifest,
  type PackageJson,
  resolveInstalledPackageManifest,
  resolvePackageEntryFilePath,
} from "../discovery/discovery.js";
import { parseBundleWorkflowId } from "../workflow-reference/workflow-reference.js";
import { listRegisteredWorkflowEntries } from "../workflow-registry/workflow-registry.js";
import {
  parseManifestTarget,
  readBundleWorkflowManifest,
} from "../workflow-resolution/bundle-resolver.js";
import { isDirectWorkflowFileReference } from "../workflow-resolution/workflow-resolution.js";

export interface DeprecationScanTarget {
  readonly sourceFile: string;
}

export type DeprecationScanMode = "workflow-source" | "workflow-package-update";

export interface ResolveDeprecationScanTargetsOptions {
  readonly cwd: string;
  readonly homeDir?: string;
  readonly includeDiscovered?: boolean;
  readonly packageNames?: readonly string[];
  readonly scanMode?: DeprecationScanMode;
}

export async function resolveDeprecationScanTargets({
  cwd,
  homeDir,
  includeDiscovered = false,
  packageNames,
  scanMode = "workflow-source",
}: ResolveDeprecationScanTargetsOptions): Promise<readonly DeprecationScanTarget[]> {
  const sourceFiles = new Set<string>();
  const registeredEntries = await listRegisteredWorkflowEntries({ cwd, homeDir });

  for (const entry of registeredEntries) {
    await addSourceFilesForTarget(sourceFiles, {
      targetRef: entry.targetRef,
      workflowName: entry.name,
      baseDir: baseDirForRegistryScope(entry.scope, cwd, homeDir),
      cwd,
      packageNames,
      scanMode,
    });
  }

  if (includeDiscovered) {
    for (const workflow of await discoverWorkflows({ cwd }).catch(() => [])) {
      if (packageNames && !packageNames.includes(workflow.packageName)) {
        continue;
      }
      await addPackageSourceFile(sourceFiles, workflow.packageName, undefined, cwd, scanMode);
    }
  }

  return [...sourceFiles].map((sourceFile) => ({ sourceFile }));
}

interface AddSourceFilesForTargetOptions {
  readonly targetRef: string;
  readonly workflowName: string;
  readonly baseDir: string;
  readonly cwd: string;
  readonly packageNames?: readonly string[];
  readonly scanMode: DeprecationScanMode;
}

async function addSourceFilesForTarget(
  sourceFiles: Set<string>,
  options: AddSourceFilesForTargetOptions,
): Promise<void> {
  const normalizedTargetRef = normalizeRegistryTargetRef(options.targetRef, options.baseDir);
  const target = parseRegisteredPackageTarget(normalizedTargetRef, options.workflowName);
  if (target !== undefined) {
    if (options.packageNames && !options.packageNames.includes(target.packageName)) {
      return;
    }
    await addPackageSourceFile(
      sourceFiles,
      target.packageName,
      target.workflowName,
      options.cwd,
      options.scanMode,
    );
    return;
  }

  const directSourceFile = resolveDirectSourceFile(normalizedTargetRef);
  if (directSourceFile !== undefined && options.scanMode === "workflow-source") {
    sourceFiles.add(directSourceFile);
  }
}

function baseDirForRegistryScope(
  scope: "local" | "project" | "global",
  cwd: string,
  homeDir: string | undefined,
): string {
  return scope === "global" ? (homeDir ?? homedir()) : cwd;
}

function normalizeRegistryTargetRef(targetRef: string, baseDir: string): string {
  if (targetRef === "~") {
    return baseDir;
  }
  if (targetRef.startsWith("~/") || targetRef.startsWith("~\\")) {
    return resolve(baseDir, targetRef.slice(2));
  }
  if (isDirectWorkflowFileReference(targetRef) && !isAbsolute(targetRef)) {
    return resolve(baseDir, targetRef);
  }
  return targetRef;
}

function resolveDirectSourceFile(targetRef: string): string | undefined {
  if (!isDirectWorkflowFileReference(targetRef)) {
    return undefined;
  }
  return resolve(targetRef);
}

interface RegisteredPackageTarget {
  readonly packageName: string;
  readonly workflowName?: string;
}

function parseRegisteredPackageTarget(
  targetRef: string,
  defaultWorkflowName: string,
): RegisteredPackageTarget | undefined {
  const bundleRef = parseBundleWorkflowId(targetRef);
  if (bundleRef !== undefined) {
    return { packageName: bundleRef.packageName, workflowName: bundleRef.workflowName };
  }

  const legacyIndex = targetRef.lastIndexOf(":");
  if (legacyIndex > 0 && !isAbsolute(targetRef)) {
    return { packageName: targetRef.slice(0, legacyIndex), workflowName: defaultWorkflowName };
  }

  if (isDirectWorkflowFileReference(targetRef)) {
    return undefined;
  }

  return { packageName: targetRef };
}

async function addPackageSourceFile(
  sourceFiles: Set<string>,
  packageName: string,
  workflowName: string | undefined,
  cwd: string,
  scanMode: DeprecationScanMode,
): Promise<void> {
  const manifest = await resolvePackageManifest(packageName, cwd);
  if (manifest === undefined) {
    return;
  }

  if (hasBundleWorkflowManifest(manifest.packageJson)) {
    for (const sourceFile of resolveBundleManifestSourceFilesForMode({
      packageJson: manifest.packageJson,
      packageDir: manifest.packageDir,
      packageName,
      workflowName,
      scanMode,
    })) {
      sourceFiles.add(sourceFile);
    }
    return;
  }

  sourceFiles.add(resolvePackageEntryFilePath(manifest.packageJson, manifest.packageDir));
}

async function resolvePackageManifest(
  packageName: string,
  cwd: string,
): Promise<InstalledPackageManifest | undefined> {
  if (!isLocalPackageReference(packageName)) {
    return resolveInstalledPackageManifest(packageName, cwd);
  }

  const packageDir = resolve(cwd, packageName);
  const packageJsonPath = resolve(packageDir, "package.json");
  try {
    return {
      packageJsonPath,
      packageDir,
      packageJson: JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJson &
        Record<string, unknown>,
    };
  } catch {
    return undefined;
  }
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

function resolveBundleManifestSourceFilesForMode({
  packageJson,
  packageDir,
  packageName,
  workflowName,
  scanMode,
}: {
  readonly packageJson: Record<string, unknown>;
  readonly packageDir: string;
  readonly packageName: string;
  readonly workflowName: string | undefined;
  readonly scanMode: DeprecationScanMode;
}): readonly string[] {
  if (scanMode === "workflow-package-update") {
    return resolveBundleManifestSourceFiles(packageJson, packageDir, packageName);
  }

  const sourceFile = resolveBundleManifestSourceFile(
    packageJson,
    packageDir,
    packageName,
    workflowName,
  );
  return sourceFile === undefined ? [] : [sourceFile];
}

export async function resolveBundleWorkflowScanTargets(
  packageName: string,
  cwd: string,
): Promise<readonly DeprecationScanTarget[]> {
  const manifest = await resolvePackageManifest(packageName, cwd);
  if (manifest === undefined || !hasBundleWorkflowManifest(manifest.packageJson)) {
    return [];
  }
  return resolveBundleManifestSourceFiles(
    manifest.packageJson,
    manifest.packageDir,
    packageName,
  ).map((sourceFile) => ({ sourceFile }));
}

function resolveBundleManifestSourceFiles(
  packageJson: Record<string, unknown>,
  packageDir: string,
  packageName: string,
): readonly string[] {
  try {
    const workflows = readBundleWorkflowManifest(packageJson, packageName);
    return Object.entries(workflows).map(([workflowName, target]) =>
      resolve(packageDir, parseManifestTarget(target, packageName, workflowName).modulePath),
    );
  } catch {
    // Ignore malformed bundle manifests during deprecation preflight target discovery.
    return [];
  }
}

function resolveBundleManifestSourceFile(
  packageJson: Record<string, unknown>,
  packageDir: string,
  packageName: string,
  workflowName: string | undefined,
): string | undefined {
  if (workflowName === undefined) {
    return undefined;
  }

  try {
    const workflows = readBundleWorkflowManifest(packageJson, packageName);
    const target = workflows[workflowName];
    if (target === undefined) {
      return undefined;
    }
    return resolve(packageDir, parseManifestTarget(target, packageName, workflowName).modulePath);
  } catch {
    // Ignore malformed bundle manifests during deprecation preflight target discovery.
    return undefined;
  }
}

function hasBundleWorkflowManifest(packageJson: Record<string, unknown>): boolean {
  const stepkit = packageJson.stepkit;
  return isRecord(stepkit) && "workflows" in stepkit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
