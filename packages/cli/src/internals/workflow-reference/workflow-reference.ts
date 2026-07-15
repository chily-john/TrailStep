import { CliUsageError } from "../command.types.js";
import type { WorkflowReference } from "./workflow-reference.types.js";

export function parseWorkflowId(workflowId: string): WorkflowReference {
  const separatorIndex = workflowId.lastIndexOf(":");
  if (separatorIndex <= 0 || separatorIndex === workflowId.length - 1) {
    throw new CliUsageError(
      "Workflow id must include a package and exported workflow name separated by a colon.",
    );
  }
  return {
    packageName: workflowId.slice(0, separatorIndex),
    exportName: workflowId.slice(separatorIndex + 1),
  };
}
