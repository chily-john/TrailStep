import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Workflow } from "@stepkit/core";

import type { BundleWorkflowReference } from "../workflow-reference/workflow-reference.types.js";
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

let freshImportCounter = 0;

export async function loadBundleWorkflow(
  specifier: BundleWorkflowSpecifier,
  options: LoadBundleWorkflowOptions,
): Promise<ResolvedBundleWorkflow> {
  const packageJsonPath = resolvePackageJsonPath(specifier.packageName, options.cwd);
  const packageDir = dirname(packageJsonPath);
  const packageJson = await readPackageJson(packageJsonPath, specifier.packageName);
  const workflows = readStepkitWorkflows(packageJson, specifier.packageName);
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
    const moduleUrl = pathToFileURL(modulePath);
    if (options.freshImport === true) {
      freshImportCounter += 1;
      moduleUrl.searchParams.set("stepkitImport", `${freshImportCounter}`);
    }
    workflowModule = (await import(moduleUrl.href)) as Record<string, unknown>;
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

  return {
    id: `${specifier.packageName}#${specifier.workflowName}`,
    workflow,
    workflowRef: {
      kind: "bundle",
      packageName: specifier.packageName,
      workflowName: specifier.workflowName,
      exportName: parsedTarget.exportName,
    },
  };
}

function resolvePackageJsonPath(packageName: string, cwd: string): string {
  if (isLocalPackageReference(packageName)) {
    return resolve(cwd, packageName, "package.json");
  }

  try {
    return createRequire(resolve(cwd, "package.json")).resolve(`${packageName}/package.json`);
  } catch (error) {
    throw new WorkflowResolutionError(`Bundle package not found: ${packageName}`, { cause: error });
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

function readStepkitWorkflows(packageJson: unknown, packageName: string): Record<string, string> {
  if (!isPlainObject(packageJson)) {
    throw new WorkflowResolutionError(
      `Invalid package manifest for bundle package: ${packageName}`,
    );
  }

  const stepkit = packageJson.stepkit;
  if (!isPlainObject(stepkit) || !isPlainObject(stepkit.workflows)) {
    throw new WorkflowResolutionError(
      `Missing stepkit.workflows manifest metadata in bundle package: ${packageName}`,
    );
  }

  const workflows = stepkit.workflows;
  if (!Object.values(workflows).every((target) => typeof target === "string")) {
    throw new WorkflowResolutionError(
      `Invalid stepkit.workflows manifest metadata in bundle package: ${packageName}`,
    );
  }

  return workflows as Record<string, string>;
}

function parseManifestTarget(
  target: string,
  packageName: string,
  workflowName: string,
): { modulePath: string; exportName: string } {
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
