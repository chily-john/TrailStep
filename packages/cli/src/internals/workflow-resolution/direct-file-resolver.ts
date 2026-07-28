import { stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Workflow } from "@stepkit/core";
import { tsImport } from "tsx/esm/api";

import { CliUsageError } from "../command.types.js";
import { WorkflowResolutionError } from "./workflow-resolution-error.js";
import { isWorkflow } from "./workflow-validator.js";

export interface LoadDirectWorkflowFileOptions {
  readonly cwd: string;
}

export interface ResolvedDirectWorkflowFile {
  readonly id: string;
  readonly workflow: Workflow;
}

export interface ResolvedDirectWorkflowExports {
  readonly id: string;
  readonly modulePath: string;
  readonly exportName?: string;
  readonly workflows: readonly DirectWorkflowExportDescriptor[];
}

export interface DirectWorkflowExportDescriptor {
  readonly name: string;
  readonly workflow: Workflow;
}

interface DirectWorkflowSourceRef {
  readonly modulePath: string;
  readonly canonicalSourceRef: string;
  readonly exportName?: string;
}

const extensionlessSourceCandidates = [".ts", ".mts", ".js", ".mjs"] as const;
const directoryIndexCandidates = ["index.ts", "index.mts", "index.js", "index.mjs"] as const;

export async function loadDirectWorkflowFile(
  rawPath: string,
  options: LoadDirectWorkflowFileOptions,
): Promise<ResolvedDirectWorkflowFile> {
  const resolvedRef = await resolveDirectWorkflowSourceRef(rawPath, options);
  const workflowModule = await importDirectWorkflowModule(resolvedRef.modulePath);
  const workflow = selectWorkflowExport(
    workflowModule,
    resolvedRef.modulePath,
    resolvedRef.exportName,
  );

  return { id: resolvedRef.canonicalSourceRef, workflow };
}

export async function loadDirectWorkflowExports(
  rawPath: string,
  options: LoadDirectWorkflowFileOptions,
): Promise<ResolvedDirectWorkflowExports> {
  const resolvedRef = await resolveDirectWorkflowSourceRef(rawPath, options);
  const workflowModule = await importDirectWorkflowModule(resolvedRef.modulePath);
  const workflowExports = listDirectWorkflowExports(normalizeWorkflowModule(workflowModule));

  if (resolvedRef.exportName === undefined) {
    return {
      id: resolvedRef.canonicalSourceRef,
      modulePath: resolvedRef.modulePath,
      workflows: workflowExports,
    };
  }

  const workflow = workflowExports.find((entry) => entry.name === resolvedRef.exportName);
  return {
    id: resolvedRef.canonicalSourceRef,
    modulePath: resolvedRef.modulePath,
    exportName: resolvedRef.exportName,
    workflows: workflow === undefined ? [] : [workflow],
  };
}

export async function resolveDirectWorkflowSourceRef(
  rawRef: string,
  options: LoadDirectWorkflowFileOptions,
): Promise<DirectWorkflowSourceRef> {
  const { pathRef, exportName } = splitExportName(rawRef);
  const basePath = isAbsolute(pathRef) ? resolve(pathRef) : resolve(options.cwd, pathRef);
  const modulePath = await resolveDirectWorkflowSourcePath(basePath);

  return { modulePath, canonicalSourceRef: modulePath, exportName };
}

export async function importDirectWorkflowModule(path: string): Promise<Record<string, unknown>> {
  try {
    if (isTypeScriptSourcePath(path)) {
      return (await tsImport(pathToFileURL(path).href, {
        parentURL: pathToFileURL(`${process.cwd()}/`).href,
      })) as Record<string, unknown>;
    }

    return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  } catch (error) {
    throw new WorkflowResolutionError(`Unable to import direct workflow source: ${path}`, {
      cause: error,
    });
  }
}

async function resolveDirectWorkflowSourcePath(basePath: string): Promise<string> {
  const extension = extname(basePath).toLowerCase();

  if (extension === ".tsx") {
    throwUnsupportedTsx(basePath);
  }

  if (extension !== "") {
    if (await fileExists(basePath)) {
      return basePath;
    }
    const sourceKind = /\.[cm]?js$/iu.test(extension) ? "file" : "source";
    throw new CliUsageError(`Direct workflow ${sourceKind} not found: ${basePath}`);
  }

  if (await fileExists(basePath)) {
    return basePath;
  }

  if (await directoryExists(basePath)) {
    const directoryPath = await resolveDirectoryIndexCandidate(basePath);
    if (directoryPath !== undefined) {
      return directoryPath;
    }
    throw new CliUsageError(`Direct workflow source not found: ${basePath}`);
  }

  const filePath = await resolveExtensionlessCandidate(basePath);
  if (filePath !== undefined) {
    return filePath;
  }

  throw new CliUsageError(`Direct workflow source not found: ${basePath}`);
}

async function resolveExtensionlessCandidate(basePath: string): Promise<string | undefined> {
  for (const extension of extensionlessSourceCandidates) {
    const candidate = `${basePath}${extension}`;
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  if (await fileExists(`${basePath}.tsx`)) {
    throwUnsupportedTsx(`${basePath}.tsx`);
  }

  return undefined;
}

async function resolveDirectoryIndexCandidate(directoryPath: string): Promise<string | undefined> {
  for (const indexFile of directoryIndexCandidates) {
    const candidate = join(directoryPath, indexFile);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  const tsxIndexPath = join(directoryPath, "index.tsx");
  if (await fileExists(tsxIndexPath)) {
    throwUnsupportedTsx(tsxIndexPath);
  }

  return undefined;
}

function splitExportName(rawRef: string): {
  readonly pathRef: string;
  readonly exportName?: string;
} {
  const hashIndex = rawRef.lastIndexOf("#");
  if (hashIndex === -1) {
    return { pathRef: rawRef };
  }

  return { pathRef: rawRef.slice(0, hashIndex), exportName: rawRef.slice(hashIndex + 1) };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isTypeScriptSourcePath(path: string): boolean {
  return /\.(?:ts|mts)$/iu.test(path);
}

function throwUnsupportedTsx(path: string): never {
  throw new CliUsageError(
    `Unsupported direct workflow source extension .tsx for ${path}. JSX workflow source files are not supported by stepkit add/run yet; use .ts, .mts, .js, or .mjs.`,
  );
}

function selectWorkflowExport(
  workflowModule: Record<string, unknown>,
  path: string,
  exportName?: string,
): Workflow {
  const normalizedModule = normalizeWorkflowModule(workflowModule);
  const workflowExports = listDirectWorkflowExports(normalizedModule);
  const availableWorkflowExports = formatAvailableWorkflowExports(workflowExports);

  if (exportName !== undefined) {
    if (exportName.length === 0) {
      throw new WorkflowResolutionError(
        `Invalid workflow export name in direct workflow source: ${path}. Use path#exportName to select a workflow export. ${availableWorkflowExports}`,
      );
    }

    const exportedValue = normalizedModule[exportName];
    if (isWorkflow(exportedValue)) {
      return exportedValue;
    }

    if (!Object.hasOwn(normalizedModule, exportName)) {
      throw new WorkflowResolutionError(
        `Missing workflow export ${exportName} in direct workflow source: ${path}. ${availableWorkflowExports}`,
      );
    }

    throw new WorkflowResolutionError(
      `Invalid workflow export ${exportName} in direct workflow source: ${path}. ${availableWorkflowExports}`,
    );
  }

  if (workflowExports.length === 0) {
    throw new WorkflowResolutionError(`No workflows found in direct workflow file: ${path}`);
  }

  if (workflowExports.length > 1) {
    throw new WorkflowResolutionError(
      `Direct workflow file has multiple workflow exports: ${path}. Use path#exportName to select one workflow export, or use bulk add to register all workflows. ${availableWorkflowExports}`,
    );
  }

  // Direct local files intentionally select by count, not by export name: a default export
  // is accepted only when it is the sole valid workflow export, so default + named workflows
  // remains ambiguous instead of silently choosing one workflow.
  return workflowExports[0]?.workflow as Workflow;
}

export function listDirectWorkflowExports(
  workflowModule: Record<string, unknown>,
): readonly DirectWorkflowExportDescriptor[] {
  return Object.entries(workflowModule)
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .filter((entry): entry is [string, Workflow] => isWorkflow(entry[1]))
    .map(([name, workflow]) => ({ name, workflow }));
}

function formatAvailableWorkflowExports(
  workflowExports: readonly DirectWorkflowExportDescriptor[],
): string {
  if (workflowExports.length === 0) {
    return "Available workflow exports: none.";
  }

  return `Available workflow exports: ${workflowExports.map((entry) => entry.name).join(", ")}.`;
}

function normalizeWorkflowModule(workflowModule: Record<string, unknown>): Record<string, unknown> {
  const defaultExport = workflowModule.default;
  if (isPlainObject(defaultExport) && !isWorkflow(defaultExport) && "default" in defaultExport) {
    return { ...workflowModule, default: defaultExport.default };
  }

  return workflowModule;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
