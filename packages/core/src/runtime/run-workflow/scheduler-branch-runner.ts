import { mkdir } from "node:fs/promises";
import type { ContinuationResult } from "../../authoring/step/continuation.types.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import { readBranchRunState, writeBranchRunState } from "../artifacts/run-storage.js";
import { resolveStepArtifactPaths } from "../artifacts/step-artifacts.js";
import {
  type RunContinuationResult,
  runContinuation,
} from "../continuation/run-continuation/run-continuation.js";
import { createQueuedRunState } from "../run-context/create-run-context.js";
import { runContextStorage } from "../run-context/run-context-storage.js";
import {
  branchIdBaseForNode,
  explicitDuplicateBranchIdFailure,
  invalidArrayCandidateFailure,
  isRunnableBranchCandidate,
  requestedBranchMetadata,
  workflowIdForBranchNode,
} from "./scheduler-branch-identity.js";
import { decorateBranchEvent } from "./scheduler-events.js";
import {
  branchSettlementForJoin,
  cancelPreventableBranches,
  createBranchRecord,
  isBranchTerminalStatus,
  persistBranch,
  persistTrack,
} from "./scheduler-track-state.js";
import type {
  BranchState,
  QueuedBranch,
  SchedulerBranchScheduling,
  SchedulerRuntime,
  TrackTerminalKind,
} from "./scheduler-types.js";
import { normalizeParallelOptions } from "./scheduler-worker-pool.js";

export function allocateStepIndex(runtime: SchedulerRuntime, branch: BranchState): number {
  if (runtime.nextStepIndex >= runtime.options.maxSteps) {
    throw new Error(`workflow exceeded maxSteps guard (${runtime.options.maxSteps})`);
  }
  runtime.nextStepIndex += 1;
  branch.latestStepIndex = runtime.nextStepIndex;
  branch.updatedAt = new Date().toISOString();
  return runtime.nextStepIndex;
}

export function allocateBranchId(runtime: SchedulerRuntime, node: ContinuationResult): string {
  const explicitBranchId = requestedBranchMetadata(node).requestedBranchId;
  if (explicitBranchId !== undefined) {
    return explicitBranchId;
  }

  const baseBranchId = branchIdBaseForNode(node);
  let suffix = 1;
  while (runtime.branches.some((branch) => branch.branchId === `${baseBranchId}-${suffix}`)) {
    suffix += 1;
  }
  runtime.nextBranchId = Math.max(runtime.nextBranchId, suffix + 1);
  return `${baseBranchId}-${suffix}`;
}

export function enqueueBranch(
  runtime: SchedulerRuntime,
  node: ContinuationResult,
  parentBranchId: string | undefined,
  source: string,
  requireRunnableBranchCandidate: boolean,
  joinContinuation = false,
  scheduling?: SchedulerBranchScheduling,
): BranchState {
  const branch = createBranchRecord({
    node,
    parentBranchId,
    source,
    workflowId: workflowIdForBranchNode(node, runtime.options.workflowId),
    branchId:
      parentBranchId === undefined && runtime.branches.length === 0
        ? runtime.rootBranchId
        : allocateBranchId(runtime, node),
    joinContinuation,
  });
  runtime.branches.push(branch);
  if (runtime.terminalResult === undefined) {
    runtime.queue.push({
      node,
      branch,
      source,
      requireRunnableBranchCandidate,
      failurePolicy: scheduling?.failurePolicy ?? "fail-fast",
      ...(scheduling?.parallelGroupId === undefined
        ? {}
        : { parallelGroupId: scheduling.parallelGroupId }),
      ...(scheduling?.parallelConcurrency === undefined
        ? {}
        : { parallelConcurrency: scheduling.parallelConcurrency }),
    });
  } else {
    branch.status = "cancelled";
    branch.updatedAt = new Date().toISOString();
  }
  return branch;
}

export async function cancelQueuedAndPreventableBranches(
  runtime: SchedulerRuntime,
  preservedBranchId?: string,
): Promise<void> {
  runtime.queue.length = 0;
  await cancelPreventableBranches(runtime.branches, runtime.options.runDir, preservedBranchId);
}

export async function terminalizeTrack(
  runtime: SchedulerRuntime,
  result: RunContinuationResult,
  terminal?: { readonly branchId: string; readonly kind: TrackTerminalKind },
): Promise<void> {
  if (runtime.terminalResult === undefined) {
    runtime.terminalResult = result;
    runtime.terminalBranchId = terminal?.branchId;
    runtime.terminalKind = terminal?.kind;
    await cancelQueuedAndPreventableBranches(runtime, terminal?.branchId);
  }
}

export async function runWithBranchState<T>(
  runtime: SchedulerRuntime,
  branchId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const parentContext = runContextStorage.getStore();
  if (!parentContext || (!runtime.splitOccurred && branchId === runtime.rootBranchId)) {
    return await fn();
  }

  const branchContext = {
    ...parentContext,
    state: createQueuedRunState({
      read: () => readBranchRunState(runtime.options.runDir, branchId),
      write: (nextState) => writeBranchRunState(runtime.options.runDir, branchId, nextState),
    }),
  };
  return await runContextStorage.run(branchContext, fn);
}

export async function runBranch(
  runtime: SchedulerRuntime,
  queued: QueuedBranch,
): Promise<RunContinuationResult> {
  const { node, branch, source, requireRunnableBranchCandidate, failurePolicy } = queued;
  const options = runtime.options;
  if (requireRunnableBranchCandidate && !isRunnableBranchCandidate(node)) {
    branch.status = "failed";
    branch.updatedAt = new Date().toISOString();
    await persistBranch(options.runDir, branch);
    return invalidArrayCandidateFailure(source);
  }

  branch.status = "running";
  branch.updatedAt = new Date().toISOString();
  await persistBranch(options.runDir, branch);

  const branchResult = await runWithBranchState(runtime, branch.branchId, async () =>
    runContinuation({
      node,
      runId: options.runId,
      workflowId: options.workflowId,
      emit: async (event) => {
        if (event.type === "step.started" && event.stepId !== undefined) {
          branch.latestStepId = event.stepId;
        }
        if (runtime.splitOccurred && event.type === "step.started" && event.stepId !== undefined) {
          const stepArtifacts = resolveStepArtifactPaths({
            runDir: options.runDir,
            stepId: event.stepId,
            stepIndex: branch.latestStepIndex,
          });
          await mkdir(stepArtifacts.stepDir, { recursive: true });
        }
        await options.emit(
          decorateBranchEvent(event, options.runId, branch, runtime.splitOccurred),
        );
      },
      maxSteps: options.maxSteps,
      initialSource:
        !runtime.splitOccurred && branch.branchId === runtime.rootBranchId
          ? source
          : `${source} branch ${branch.branchId}`,
      allocateStepIndex: () => allocateStepIndex(runtime, branch),
      returnContinuationArrays: true,
      workflowAgents: options.workflowAgents,
      workflowTimeout: options.workflowTimeout,
      ...(options.workflowRetry === undefined ? {} : { workflowRetry: options.workflowRetry }),
      runDir: options.runDir,
      projectCwd: options.projectCwd,
      cwd: options.cwd,
      trailstepConfig: options.trailstepConfig,
      workingAgentProcessRunner: options.workingAgentProcessRunner,
      providerWorkingRunner: options.providerWorkingRunner,
      processRunner: options.processRunner,
      ...(options.waitResumeBranches?.[branch.branchId] === undefined
        ? {}
        : { resumeWait: options.waitResumeBranches[branch.branchId] }),
    }),
  );

  branch.updatedAt = new Date().toISOString();
  const branchResultWasSplit = branchResult.status === "split";
  if (runtime.terminalResult !== undefined) {
    if (!isBranchTerminalStatus(branch.status)) {
      branch.status = "cancelled";
      branch.updatedAt = new Date().toISOString();
    }
    await persistBranch(options.runDir, branch);
    return { status: "cancelled", cancellation: { requestedAt: branch.updatedAt } };
  }

  if (branchResult.status === "absoluteSuccess") {
    branch.status = "done";
    branch.output = branchResult.output;
    branch.message = branchResult.message;
    branch.terminalKind = "absoluteDone";
    await terminalizeTrack(runtime, branchResult, {
      branchId: branch.branchId,
      kind: "absoluteDone",
    });
    await persistBranch(options.runDir, branch);
    return branchResult;
  }

  if (branchResult.status === "absoluteFailure") {
    branch.status = "failed";
    branch.failure = branchResult.failure;
    branch.message = branchResult.message;
    branch.terminalKind = "absoluteFail";
    await terminalizeTrack(runtime, branchResult, {
      branchId: branch.branchId,
      kind: "absoluteFail",
    });
    await persistBranch(options.runDir, branch);
    return branchResult;
  }

  if (branchResult.status === "failure") {
    branch.status = "failed";
    branch.failure = branchResult.failure;
    branch.message = branchResult.message;
    if (failurePolicy === "all-settled") {
      await enqueueSatisfiedJoins(runtime, branch);
      await persistBranch(options.runDir, branch);
      await persistTrack(
        options,
        runtime.workers,
        runtime.rootBranchId,
        runtime.branches,
        "running",
        runtime.splitOccurred,
      );
      return { status: "success", output: {} };
    }
    await terminalizeTrack(runtime, branchResult, { branchId: branch.branchId, kind: "failure" });
    await persistBranch(options.runDir, branch);
    return branchResult;
  }

  if (branchResult.status === "waiting") {
    branch.status = "waiting";
    branch.wait = branchResult.wait;
    await terminalizeTrack(runtime, branchResult, { branchId: branch.branchId, kind: "waiting" });
    await persistBranch(options.runDir, branch);
    return branchResult;
  }

  if (branchResult.status === "cancelled") {
    branch.status = "cancelled";
    await terminalizeTrack(runtime, branchResult, { branchId: branch.branchId, kind: "cancelled" });
    await persistBranch(options.runDir, branch);
    return branchResult;
  }

  if (branchResult.status === "split") {
    if (!branchResult.nodes.every(isRunnableBranchCandidate)) {
      branch.status = "failed";
      branch.failure = invalidArrayCandidateFailure(branchResult.source).failure;
      await persistBranch(options.runDir, branch);
      return invalidArrayCandidateFailure(branchResult.source);
    }
    const duplicateBranchIdFailure = explicitDuplicateBranchIdFailure(
      branchResult.nodes,
      branchResult.source,
      runtime.branches,
    );
    if (duplicateBranchIdFailure !== undefined) {
      branch.status = "failed";
      branch.failure = duplicateBranchIdFailure.failure;
      await persistBranch(options.runDir, branch);
      return duplicateBranchIdFailure;
    }
    runtime.splitOccurred = true;
    branch.status = "split";
    branch.splitSource = branchResult.source;
    if (branch.latestStepId !== undefined && branch.latestStepIndex > 0) {
      const stepArtifacts = resolveStepArtifactPaths({
        runDir: options.runDir,
        stepId: branch.latestStepId,
        stepIndex: branch.latestStepIndex,
      });
      await mkdir(stepArtifacts.stepDir, { recursive: true });
    }
    if (runtime.terminalResult !== undefined) {
      branch.status = "cancelled";
      branch.updatedAt = new Date().toISOString();
      await persistBranch(options.runDir, branch);
      return { status: "cancelled", cancellation: { requestedAt: branch.updatedAt } };
    }
    const parallelOptions = normalizeParallelOptions(branchResult.parallelOptions);
    const childBranches = branchResult.nodes.map((childNode) =>
      enqueueBranch(runtime, childNode, branch.branchId, branchResult.source, true, false, {
        parallelGroupId: branch.branchId,
        ...(parallelOptions.concurrency === undefined
          ? {}
          : { parallelConcurrency: parallelOptions.concurrency }),
        failurePolicy: parallelOptions.failurePolicy,
      }),
    );
    if (branchResult.postContinuation !== undefined) {
      branch.pendingPostJoin = true;
      runtime.pendingJoins.push({
        parentBranchId: branch.branchId,
        childBranchIds: childBranches.map((childBranch) => childBranch.branchId),
        source: branchResult.source,
        failurePolicy: parallelOptions.failurePolicy,
        postContinuation: branchResult.postContinuation,
        ...(branchResult.afterPostContinuation === undefined
          ? {}
          : { afterPostContinuation: branchResult.afterPostContinuation }),
        completed: {},
      });
    }
    await Promise.all(
      runtime.branches.map((persistedBranch) => persistBranch(options.runDir, persistedBranch)),
    );
  } else if (branchResult.status === "success") {
    branch.status = "done";
    branch.output = branchResult.output;
    branch.message = branchResult.message;
    await enqueueSatisfiedJoins(runtime, branch);
  }
  await persistBranch(options.runDir, branch);
  await persistTrack(
    options,
    runtime.workers,
    runtime.rootBranchId,
    runtime.branches,
    "running",
    runtime.splitOccurred,
  );
  return branchResultWasSplit ? { status: "success", output: {} } : branchResult;
}

export async function enqueueSatisfiedJoins(
  runtime: SchedulerRuntime,
  branch: BranchState,
): Promise<void> {
  for (const join of runtime.pendingJoins) {
    if (!join.childBranchIds.includes(branch.branchId)) {
      continue;
    }
    const settlement = branchSettlementForJoin(branch, join.failurePolicy);
    if (settlement === undefined) {
      continue;
    }
    join.completed = { ...join.completed, [branch.branchId]: settlement };
    if (Object.keys(join.completed).length !== join.childBranchIds.length) {
      continue;
    }

    let nextNode: ContinuationResult;
    try {
      nextNode = await join.postContinuation({ status: "completed", branches: join.completed });
    } catch (error) {
      await terminalizeTrack(runtime, {
        status: "failure",
        failure: {
          code: "step_execution_failed",
          message: `parallel post failed for ${join.source}: ${String(error)}`,
        },
      });
      continue;
    }
    const postBranch = enqueueBranch(
      runtime,
      nextNode,
      join.parentBranchId,
      `post for ${join.source}`,
      false,
      true,
    );
    if (join.afterPostContinuation !== undefined) {
      const afterPostContinuation = join.afterPostContinuation;
      runtime.pendingJoins.push({
        parentBranchId: join.parentBranchId,
        childBranchIds: [postBranch.branchId],
        source: `post for ${join.source}`,
        failurePolicy: "fail-fast",
        postContinuation: async (aggregateOutput) => {
          const branches = aggregateOutput.branches as Record<string, PlainObject> | undefined;
          const [output] = Object.values(branches ?? {});
          return afterPostContinuation(output ?? {});
        },
        completed: {},
      });
    }
  }
}
