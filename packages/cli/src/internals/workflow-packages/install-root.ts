import { homedir } from "node:os";
import { join } from "node:path";

import type {
  WorkflowPackageRegistryMetadata,
  WorkflowRegistryContext,
  WorkflowRegistryScope,
} from "../workflow-registry/workflow-registry.js";

export function workflowPackageInstallRootForScope(
  scope: WorkflowRegistryScope,
  context: WorkflowRegistryContext,
): string {
  if (scope === "global") {
    return join(context.homeDir ?? homedir(), ".trailstep", "packages");
  }
  return context.cwd;
}

export function workflowPackageInstallRootForMetadata(
  metadata: WorkflowPackageRegistryMetadata,
  context: WorkflowRegistryContext,
): string {
  return workflowPackageInstallRootForScope(metadata.installScope, context);
}

export function workflowPackageInstallSaveArgsForScope(
  scope: WorkflowRegistryScope,
): readonly string[] {
  return scope === "global" ? ["--save"] : ["--save-dev"];
}
