import { isFailureLikeError } from "../../contracts/failures/failure.js";
import type { RunContinuationResult } from "../continuation/run-continuation/run-continuation.js";
import {
  explicitDuplicateBranchIdFailure,
  invalidArrayCandidateFailure,
  isRunnableBranchCandidate,
} from "./scheduler-branch-identity.js";
import {
  cancelQueuedAndPreventableBranches,
  enqueueBranch,
  runBranch,
  terminalizeTrack,
} from "./scheduler-branch-runner.js";
import { createPersistedTrackRetryPlan } from "./scheduler-retry-plan.js";
import {
  branchSettlementForSummary,
  isBranchTerminalStatus,
  persistBranch,
  persistTrack,
  publicTerminalResult,
  trackStatusFromTerminalResult,
} from "./scheduler-track-state.js";
import type {
  BranchState,
  QueuedBranch,
  RunRootContinuationArraySchedulerOptions,
  SchedulerRuntime,
} from "./scheduler-types.js";
import {
  decrementActiveParallelGroup,
  incrementActiveParallelGroup,
  resolveSchedulerWorkerCount,
  shiftRunnableQueuedBranch,
} from "./scheduler-worker-pool.js";

export type { RunRootContinuationArraySchedulerOptions };

export async function runRootContinuationArrayScheduler(
  options: RunRootContinuationArraySchedulerOptions,
): Promise<RunContinuationResult> {
  const resolvedWorkers = resolveSchedulerWorkerCount(options.workers);
  if (!resolvedWorkers.ok) {
    return resolvedWorkers.failure;
  }

  const workers = resolvedWorkers.workers;
  const rootBranchId = "root";
  const branches: BranchState[] = [];
  const queue: QueuedBranch[] = [];
  const runtime: SchedulerRuntime = {
    options,
    branches,
    queue,
    pendingJoins: [],
    activeByParallelGroup: new Map<string, number>(),
    workers,
    rootBranchId,
    splitOccurred: options.rootIsArray === true,
    nextStepIndex: options.retry?.initialExecutedSteps ?? 0,
    nextBranchId: 1,
    terminalResult: undefined,
    terminalBranchId: undefined,
    terminalKind: undefined,
  };

  if (options.retry !== undefined) {
    const retryPlan = await createPersistedTrackRetryPlan({
      nodes: options.nodes,
      runDir: options.runDir,
      workflowId: options.workflowId,
      initialSource: options.initialSource,
      track: options.retry.track,
    });
    if (retryPlan.status === "failure") {
      return retryPlan.failure;
    }
    branches.push(...retryPlan.branches);
    queue.push(...retryPlan.queue);
    runtime.splitOccurred = retryPlan.splitOccurred;
    runtime.nextBranchId = retryPlan.nextBranchId;
  } else if (options.rootIsArray === true) {
    if (!options.nodes.every(isRunnableBranchCandidate)) {
      return invalidArrayCandidateFailure(options.initialSource);
    }
    const duplicateBranchIdFailure = explicitDuplicateBranchIdFailure(
      options.nodes,
      options.initialSource,
      branches,
    );
    if (duplicateBranchIdFailure !== undefined) {
      return duplicateBranchIdFailure;
    }
    for (const node of options.nodes) {
      enqueueBranch(runtime, node, rootBranchId, options.initialSource, true);
    }
  } else {
    const rootNode = options.nodes[0];
    if (rootNode === undefined) {
      return {
        status: "failure",
        failure: {
          code: "invalid_continuation",
          message: `${options.initialSource} returned an invalid continuation node.`,
        },
      };
    }
    enqueueBranch(runtime, rootNode, undefined, options.initialSource, false);
  }

  await persistTrack(options, workers, rootBranchId, branches, "running", runtime.splitOccurred);

  let activeWorkers = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      const schedule = (): void => {
        if (runtime.terminalResult !== undefined || queue.length === 0) {
          if (activeWorkers === 0) {
            resolve();
          }
          return;
        }

        while (
          runtime.terminalResult === undefined &&
          activeWorkers < workers &&
          queue.length > 0
        ) {
          const queued = shiftRunnableQueuedBranch(queue, runtime.activeByParallelGroup);
          if (queued === undefined) {
            if (activeWorkers === 0) {
              resolve();
            }
            return;
          }
          activeWorkers += 1;
          incrementActiveParallelGroup(queued.parallelGroupId, runtime.activeByParallelGroup);

          void (async () => {
            try {
              const branchResult = await runBranch(runtime, queued);
              if (branchResult.status !== "success") {
                await terminalizeTrack(runtime, branchResult);
              }
            } catch (error) {
              // A branch that THROWS (a failed persistBranch, an unexpected runtime bug) must
              // fail the track, not vanish. The previous shape rejected the outer promise from a
              // non-awaited chain, which was a no-op once the promise had already resolved.
              await reportWorkerFailure(runtime, queued, error, reject);
            } finally {
              activeWorkers -= 1;
              decrementActiveParallelGroup(queued.parallelGroupId, runtime.activeByParallelGroup);
              schedule();
            }
          })();
        }
      };

      schedule();
    });
  } catch (error) {
    // `reportWorkerFailure` records a terminal track result before it rejects, so the
    // rejection is a signal rather than the outcome. When a terminal result exists, keep going:
    // throwing from here would skip `track.json` persistence and replace the structured failure
    // (e.g. `max_steps_exceeded`) with a generic workflow error.
    if (runtime.terminalResult === undefined) {
      throw error;
    }
  }

  if (runtime.terminalResult !== undefined) {
    if (runtime.terminalResult.status !== "waiting") {
      await cancelQueuedAndPreventableBranches(runtime, runtime.terminalBranchId);
    }
    await Promise.all(branches.map((branch) => persistBranch(options.runDir, branch)));
    await persistTrack(
      options,
      workers,
      rootBranchId,
      branches,
      trackStatusFromTerminalResult(runtime.terminalResult),
      runtime.splitOccurred,
      runtime.terminalResult.status === "failure" ||
        runtime.terminalResult.status === "absoluteFailure"
        ? runtime.terminalResult.failure
        : undefined,
      runtime.terminalBranchId,
      runtime.terminalKind,
      runtime.terminalResult.status === "success" ||
        runtime.terminalResult.status === "absoluteSuccess"
        ? runtime.terminalResult.output
        : undefined,
    );
    return publicTerminalResult(runtime.terminalResult);
  }

  await Promise.all(branches.map((branch) => persistBranch(options.runDir, branch)));
  await persistTrack(options, workers, rootBranchId, branches, "completed", runtime.splitOccurred);

  const terminalBranches = branches.filter((branch) => isBranchTerminalStatus(branch.status));
  const joinContinuationBranch = [...terminalBranches]
    .reverse()
    .find((branch) => branch.joinContinuation === true && branch.status === "done");
  if (joinContinuationBranch !== undefined) {
    return {
      status: "success",
      output: joinContinuationBranch.output ?? {},
      ...(joinContinuationBranch.message === undefined
        ? {}
        : { message: joinContinuationBranch.message }),
    };
  }

  if (
    !runtime.splitOccurred &&
    terminalBranches.length === 1 &&
    terminalBranches[0]?.status === "done"
  ) {
    return {
      status: "success",
      output: terminalBranches[0].output ?? {},
      ...(terminalBranches[0].message === undefined
        ? {}
        : { message: terminalBranches[0].message }),
    };
  }

  return {
    status: "success",
    output: {
      status: "completed",
      branches: Object.fromEntries(
        terminalBranches.map((branch) => [branch.branchId, branchSettlementForSummary(branch)]),
      ),
    },
  };
}

/**
 * Turns a thrown branch into a terminal track failure and unblocks the scheduler.
 *
 * `reject` only has an effect while the outer promise is pending; when a sibling branch already
 * resolved it, the failure would otherwise be dropped. Recording it on the runtime first makes
 * the outcome observable either way.
 */
async function reportWorkerFailure(
  runtime: SchedulerRuntime,
  queued: QueuedBranch,
  error: unknown,
  reject: (error: unknown) => void,
): Promise<void> {
  const failure: RunContinuationResult & { readonly status: "failure" } = {
    status: "failure",
    // An error that already carries a structured failure (the scheduler's own `max_steps_exceeded`
    // guard, for instance) keeps its code. Collapsing it into `branch_failed` would throw away the
    // detail an operator needs to act on.
    failure: isFailureLikeError(error)
      ? error.failure
      : {
          code: "branch_failed",
          message: `Branch ${queued.branch.branchId} (${queued.source}) threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
          details: { branchId: queued.branch.branchId, source: queued.source },
        },
  };

  queued.branch.status = "failed";
  queued.branch.failure = failure.failure;
  queued.branch.updatedAt = new Date().toISOString();

  try {
    await terminalizeTrack(runtime, failure, {
      branchId: queued.branch.branchId,
      kind: "failure",
    });
  } catch {
    // terminalizeTrack persists branch state; if that also fails there is nothing left to do,
    // and the rejection below still surfaces the original error.
  }

  reject(error);
}
