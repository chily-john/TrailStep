import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Workflow } from "@stepkit/core";

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

export async function loadDirectWorkflowFile(
  rawPath: string,
  options: LoadDirectWorkflowFileOptions,
): Promise<ResolvedDirectWorkflowFile> {
  const path = isAbsolute(rawPath) ? resolve(rawPath) : resolve(options.cwd, rawPath);

  if (/\.tsx?$/iu.test(path)) {
    throw new CliUsageError(
      "TypeScript direct-file workflow loading requires a future loader decision. Use a native Node-loadable ESM file such as .mjs for now.",
    );
  }

  try {
    await access(path);
  } catch {
    throw new CliUsageError(`Direct workflow file not found: ${path}`);
  }

  let workflowModule: Record<string, unknown>;
  try {
    workflowModule = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  } catch (error) {
    throw new WorkflowResolutionError(`Unable to import direct workflow file: ${path}`, {
      cause: error,
    });
  }

  const workflow = selectWorkflowExport(workflowModule, path);

  return { id: path, workflow };
}

function selectWorkflowExport(workflowModule: Record<string, unknown>, path: string): Workflow {
  const workflowExports = Object.entries(workflowModule).filter(([, exportedValue]) =>
    isWorkflow(exportedValue),
  );

  if (workflowExports.length === 0) {
    throw new WorkflowResolutionError(`No workflows found in direct workflow file: ${path}`);
  }

  if (workflowExports.length > 1) {
    throw new WorkflowResolutionError(
      `Direct workflow file must expose exactly one workflow: ${path}. For multiple workflows, publish or reference a bundle manifest/package instead.`,
    );
  }

  // Direct local files intentionally select by count, not by export name: a default export
  // is accepted only when it is the sole valid workflow export, so default + named workflows
  // remains ambiguous instead of silently choosing one workflow.
  return workflowExports[0]?.[1] as Workflow;
}
