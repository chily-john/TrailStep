import type { ContinuationResult } from "../../authoring/step/continuation.types.js";
import { isStepNode, isWorkflowInvocationNode } from "../../authoring/step/step-node.js";
import type { RunContinuationResult } from "../continuation/run-continuation/run-continuation.js";
import type { BranchState } from "./scheduler-types.js";

export function workflowIdForBranchNode(
  node: ContinuationResult,
  fallbackWorkflowId: string,
): string {
  if (isWorkflowInvocationNode(node)) {
    return node.workflow.id;
  }

  return fallbackWorkflowId;
}

export function requestedBranchMetadata(node: ContinuationResult): {
  readonly requestedBranchId?: string;
} {
  if (isWorkflowInvocationNode(node) && node.options?.branchId !== undefined) {
    return { requestedBranchId: node.options.branchId };
  }
  if (isStepNode(node) && node.options?.branchId !== undefined) {
    return { requestedBranchId: node.options.branchId };
  }

  return {};
}

export function branchIdBaseForNode(node: ContinuationResult): string {
  const rawId = isWorkflowInvocationNode(node)
    ? node.workflow.id
    : isStepNode(node)
      ? node.config.id
      : "branch";
  return rawId.replaceAll(/[^A-Za-z0-9._-]/g, "-") || "branch";
}

export function explicitDuplicateBranchIdFailure(
  nodes: readonly ContinuationResult[],
  source: string,
  existingBranches: readonly BranchState[],
): (RunContinuationResult & { readonly status: "failure" }) | undefined {
  const seen = new Set<string>(existingBranches.map((branch) => branch.branchId));
  for (const node of nodes) {
    const branchId = requestedBranchMetadata(node).requestedBranchId;
    if (branchId === undefined) {
      continue;
    }
    if (seen.has(branchId)) {
      return {
        status: "failure",
        failure: {
          code: "duplicate_branch_id",
          message: `${source} scheduled multiple parallel branches with branchId ${JSON.stringify(
            branchId,
          )}; explicit branchId values must be unique within a parallel track.`,
        },
      };
    }
    seen.add(branchId);
  }
  return undefined;
}

export function isRunnableBranchCandidate(node: ContinuationResult): boolean {
  return isStepNode(node) || isWorkflowInvocationNode(node);
}

export function invalidArrayCandidateFailure(
  source: string,
): RunContinuationResult & { readonly status: "failure" } {
  return {
    status: "failure",
    failure: {
      code: "invalid_continuation",
      message: `${source} returned a continuation array containing non-runnable branch candidates; array candidates must be runnable step or workflow invocation nodes.`,
    },
  };
}
