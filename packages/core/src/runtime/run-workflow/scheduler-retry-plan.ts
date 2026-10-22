import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContinuationResult } from "../../authoring/step/continuation.types.js";
import { isParallelNode } from "../../authoring/step/step-node.js";
import { errorMessage } from "../../json/guards.js";
import type { RunContinuationResult } from "../continuation/run-continuation/run-continuation.js";
import type { RunWorkflowTrackRetryOptions } from "./run-workflow.types.js";
import {
  invalidArrayCandidateFailure,
  isRunnableBranchCandidate,
  requestedBranchMetadata,
} from "./scheduler-branch-identity.js";
import { branchFromJson } from "./scheduler-track-state.js";
import type {
  BranchState,
  BranchStateJson,
  QueuedBranch,
  TrackStateJson,
} from "./scheduler-types.js";

export async function createPersistedTrackRetryPlan(input: {
  readonly nodes: readonly ContinuationResult[];
  readonly runDir: string;
  readonly workflowId: string;
  readonly initialSource: string;
  readonly track?: RunWorkflowTrackRetryOptions;
}): Promise<
  | {
      readonly status: "success";
      readonly branches: readonly BranchState[];
      readonly queue: readonly QueuedBranch[];
      readonly splitOccurred: boolean;
      readonly nextBranchId: number;
    }
  | { readonly status: "failure"; readonly failure: RunContinuationResult }
> {
  let track: TrackStateJson;
  try {
    track = JSON.parse(await readFile(join(input.runDir, "track.json"), "utf8")) as TrackStateJson;
  } catch (error) {
    return {
      status: "failure",
      failure: {
        status: "failure",
        failure: {
          code: "retry_track_metadata_unreadable",
          message: `Retry target track metadata is missing or unreadable: ${errorMessage(error)}`,
        },
      },
    };
  }

  const retryRootParallelNode =
    input.nodes.length === 1 && isParallelNode(input.nodes[0]) ? input.nodes[0] : undefined;
  const retryCandidateNodes = retryRootParallelNode?.nodes ?? input.nodes;
  if (retryRootParallelNode?.postContinuation !== undefined) {
    return { status: "failure", failure: unsupportedPostJoinRetryFailure() };
  }

  if (!retryCandidateNodes.every(isRunnableBranchCandidate)) {
    return { status: "failure", failure: invalidArrayCandidateFailure(input.initialSource) };
  }

  const branches = await Promise.all(
    track.branches.map(async (branchId) =>
      branchFromJson(
        JSON.parse(
          await readFile(join(input.runDir, "branches", `${branchId}.json`), "utf8"),
        ) as BranchStateJson,
      ),
    ),
  );
  if (
    branches.some((branch) => branch.joinContinuation === true || branch.pendingPostJoin === true)
  ) {
    return { status: "failure", failure: unsupportedPostJoinRetryFailure() };
  }

  const nodesByRequestedBranchId = new Map<string, ContinuationResult>();
  for (const node of retryCandidateNodes) {
    const requestedBranchId = requestedBranchMetadata(node).requestedBranchId;
    if (requestedBranchId !== undefined) {
      nodesByRequestedBranchId.set(requestedBranchId, node);
    }
  }

  const selection = selectPersistedBranchesForRetry(branches, input.track);
  if (selection.status === "failure") {
    return selection;
  }

  const queue: QueuedBranch[] = [];
  for (const [index, branch] of branches.entries()) {
    if (!selection.branchIds.has(branch.branchId)) {
      continue;
    }
    if (retryRootParallelNode !== undefined && branch.branchId === track.rootBranchId) {
      continue;
    }

    if (branch.status === "split") {
      return {
        status: "failure",
        failure: {
          status: "failure",
          failure: {
            code: "retry_track_split_branch_unsupported",
            message: `Retrying split parent branch ${branch.branchId} is not supported; retry a failed child branch or restart the workflow instead.`,
          },
        },
      };
    }

    branch.status = "queued";
    branch.failure = undefined;
    branch.terminalKind = undefined;
    branch.message = undefined;
    branch.updatedAt = new Date().toISOString();
    if ((input.track as { mode?: unknown })?.mode !== "wait-answered") {
      branch.wait = undefined;
    }
    const rootParallelBranchIndex =
      retryRootParallelNode === undefined
        ? undefined
        : branches
            .filter((candidate) => candidate.parentBranchId === track.rootBranchId)
            .findIndex((candidate) => candidate.branchId === branch.branchId);
    const node =
      (branch.requestedBranchId === undefined
        ? undefined
        : nodesByRequestedBranchId.get(branch.requestedBranchId)) ??
      (rootParallelBranchIndex === undefined || rootParallelBranchIndex < 0
        ? retryCandidateNodes[index]
        : retryCandidateNodes[rootParallelBranchIndex]);
    if (node === undefined) {
      return {
        status: "failure",
        failure: {
          status: "failure",
          failure: {
            code: "retry_track_branch_not_found",
            message: `Retry target branch ${branch.branchId} no longer has a matching workflow branch candidate.`,
          },
        },
      };
    }
    queue.push({
      node,
      branch,
      source: branch.splitSource ?? branch.source ?? input.initialSource,
      requireRunnableBranchCandidate: true,
      failurePolicy: "fail-fast",
    });
  }

  const maxNumericBranchId = branches.reduce((max, branch) => {
    const match = /^branch-(\d+)$/.exec(branch.branchId);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

  return {
    status: "success",
    branches,
    queue,
    splitOccurred: track.splitOccurred,
    nextBranchId: maxNumericBranchId + 1,
  };
}

export function unsupportedPostJoinRetryFailure(): RunContinuationResult {
  return {
    status: "failure",
    failure: {
      code: "retry_parallel_post_join_unsupported",
      message:
        "Retrying parallel tracks with pending or completed parallel .post joins is not yet supported; restart the workflow instead.",
    },
  };
}

export function selectPersistedBranchesForRetry(
  branches: readonly BranchState[],
  track: RunWorkflowTrackRetryOptions | undefined,
):
  | { readonly status: "success"; readonly branchIds: ReadonlySet<string> }
  | { readonly status: "failure"; readonly failure: RunContinuationResult } {
  if (track === undefined) {
    return {
      status: "success",
      branchIds: new Set(
        branches
          .filter((branch) => ["failed", "waiting", "cancelled"].includes(branch.status))
          .map((branch) => branch.branchId),
      ),
    };
  }

  if (track.mode === "failed-only") {
    if ((track as { readonly branchId?: unknown }).branchId !== undefined) {
      return {
        status: "failure",
        failure: {
          status: "failure",
          failure: {
            code: "retry_track_filter_unsupported",
            message: "Track failed-only retry cannot also specify a branchId.",
          },
        },
      };
    }

    return {
      status: "success",
      branchIds: new Set(
        branches.filter((branch) => branch.status === "failed").map((branch) => branch.branchId),
      ),
    };
  }

  if (track.mode === "wait-answered") {
    return {
      status: "success",
      branchIds: new Set(
        branches
          .filter(
            (branch) =>
              branch.status === "waiting" &&
              branch.wait !== undefined &&
              typeof branch.wait === "object" &&
              typeof (branch.wait as { readonly artifactPaths?: { readonly answerFile?: unknown } })
                .artifactPaths?.answerFile === "string",
          )
          .map((branch) => branch.branchId),
      ),
    };
  }

  if (track.mode !== "branch") {
    return {
      status: "failure",
      failure: {
        status: "failure",
        failure: {
          code: "retry_track_filter_unsupported",
          message: `Unsupported track retry mode: ${String((track as { readonly mode?: unknown }).mode)}.`,
        },
      },
    };
  }

  if (typeof track.branchId !== "string" || track.branchId.length === 0) {
    return {
      status: "failure",
      failure: {
        status: "failure",
        failure: {
          code: "retry_track_branch_required",
          message: "Track branch retry requires a persisted branchId.",
        },
      },
    };
  }

  const branch = branches.find((candidate) => candidate.branchId === track.branchId);
  if (branch === undefined) {
    return {
      status: "failure",
      failure: {
        status: "failure",
        failure: {
          code: "retry_track_branch_not_found",
          message: `Retry target branch ${track.branchId} was not found in persisted track metadata.`,
        },
      },
    };
  }

  return { status: "success", branchIds: new Set([branch.branchId]) };
}
