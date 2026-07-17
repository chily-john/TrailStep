import { CliUsageError } from "../command.types.js";
import type { BundleWorkflowReference, WorkflowReference } from "./workflow-reference.types.js";

export function parseWorkflowId(workflowId: string): WorkflowReference {
  const bundleRef = parseBundleWorkflowId(workflowId);
  if (bundleRef) {
    return bundleRef;
  }

  const separatorIndex = workflowId.lastIndexOf(":");
  if (separatorIndex <= 0 || separatorIndex === workflowId.length - 1) {
    throw new CliUsageError(
      "Workflow id must include either package:workflowExport or package-or-path#workflowName.",
    );
  }
  return {
    kind: "legacy-package-export",
    packageName: workflowId.slice(0, separatorIndex),
    exportName: workflowId.slice(separatorIndex + 1),
  };
}

export function parseBundleWorkflowId(workflowId: string): BundleWorkflowReference | undefined {
  const separatorIndex = workflowId.lastIndexOf("#");
  if (separatorIndex === -1) {
    return undefined;
  }

  if (separatorIndex <= 0 || separatorIndex === workflowId.length - 1) {
    throw new CliUsageError(
      "Bundle workflow refs must use package-or-path#workflowName with both parts present.",
    );
  }

  const packageName = workflowId.slice(0, separatorIndex);
  const workflowName = workflowId.slice(separatorIndex + 1);
  return {
    kind: "bundle",
    packageName,
    workflowName,
    exportName: workflowName,
  };
}
