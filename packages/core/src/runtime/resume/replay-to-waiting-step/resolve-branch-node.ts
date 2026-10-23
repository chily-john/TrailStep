import type { ContinuationResult } from "../../../authoring/step/continuation.types.js";
import {
  isParallelNode,
  isStepNode,
  isWorkflowInvocationNode,
} from "../../../authoring/step/step-node.js";
import type { Workflow } from "../../../authoring/workflow/workflow.types.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import { branchIdBaseForNode } from "../../../runtime/run-workflow/scheduler-branch-identity.js";

/**
 * Resolves the continuation node a persisted parallel branch resumes from when
 * the workflow's `start(...)` returns a parallel node or a continuation array
 * (the typical parallel-track shape for branch-scoped wait resumes).
 *
 * Returns undefined when no branch in the start tree matches the requested
 * branch id, so callers can fall back to the unresolvable (step-shaped) start.
 */
export function resolveBranchNode<
  TInput extends PlainObject,
  TOutput extends PlainObject,
>(options: {
  readonly workflow: Workflow<TInput, TOutput>;
  readonly input: PlainObject;
  readonly branchId: string;
}): ContinuationResult | undefined {
  const startNode = options.workflow.start(options.input as TInput);
  return resolveBranchNodeFrom(startNode, options.branchId);
}

/**
 * Walks a workflow start continuation tree looking for the branch identified by
 * `branchId`. Parallel nodes and continuation arrays fan out into per-branch
 * candidates; workflow invocations scope an explicit branch id to the invoked
 * workflow's own continuation.
 */
function resolveBranchNodeFrom(
  node: ContinuationResult,
  branchId: string,
): ContinuationResult | undefined {
  if (isWorkflowInvocationNode(node)) {
    const requestedBranchId = node.options?.branchId;
    if (requestedBranchId === branchId || isDerivedBranchId(branchId, branchIdBaseForNode(node))) {
      // The branch scopes the invoked workflow's continuation, so the branch's
      // entry node is the invoked workflow's own start continuation.
      const invokedStart = node.workflow.start(node.input);
      return resolveBranchEntry(invokedStart);
    }
    return undefined;
  }

  if (isParallelNode(node) || Array.isArray(node)) {
    const children = isParallelNode(node) ? node.nodes : (node as ContinuationResult[]);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child === undefined) {
        continue;
      }
      const derivedBranchId = `${branchIdBaseForNode(child)}-${index + 1}`;
      if (branchId === derivedBranchId) {
        const resolved = resolveBranchNodeFrom(child, branchId);
        if (resolved !== undefined) {
          return resolved;
        }
        return undefined;
      }
      const resolved = resolveBranchNodeFrom(child, branchId);
      if (resolved !== undefined) {
        return resolved;
      }
    }
    return undefined;
  }

  if (isStepNode(node)) {
    const requestedBranchId = node.options?.branchId;
    if (requestedBranchId !== undefined) {
      return requestedBranchId === branchId ? node : undefined;
    }
    // Branches created from workflow start nodes without explicit branch ids
    // get derived ids of the form "<branch base>-<n>".
    const derivedBase = branchIdBaseForNode(node);
    if (derivedBase !== "" && isDerivedBranchId(branchId, derivedBase)) {
      return node;
    }
    return undefined;
  }

  return undefined;
}

/**
 * Resolves the branch entry continuation for a branch whose boundary was
 * already consumed (e.g. the invoked workflow of a branch-scoped invocation).
 */
function resolveBranchEntry(node: ContinuationResult): ContinuationResult | undefined {
  if (isParallelNode(node) || Array.isArray(node)) {
    const children = isParallelNode(node) ? node.nodes : node;
    for (const child of children) {
      const resolved = resolveBranchEntry(child);
      if (resolved !== undefined) {
        return resolved;
      }
    }
    return undefined;
  }

  if (isWorkflowInvocationNode(node)) {
    const requestedBranchId = node.options?.branchId;
    if (requestedBranchId === undefined) {
      return undefined;
    }
    const invokedStart = node.workflow.start(node.input);
    return resolveBranchEntry(invokedStart);
  }

  if (isStepNode(node)) {
    return node;
  }

  return undefined;
}

function isDerivedBranchId(branchId: string, base: string): boolean {
  if (branchId === base) {
    // A branch id may itself be a plain step id used without a suffix when the
    // branch was requested explicitly; that case is handled by the explicit
    // branch metadata path instead, so only suffixes are derived here.
    return false;
  }
  if (!branchId.startsWith(`${base}-`)) {
    return false;
  }
  const suffix = branchId.slice(base.length + 1);
  if (!/^\d+$/.test(suffix)) {
    return false;
  }
  const parsed = Number(suffix);
  return Number.isInteger(parsed) && parsed > 0;
}
