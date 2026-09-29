import { mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { TrailStepConfig } from "../../agent-targeting/targeting.types.js";
import type {
  ContinuationResult,
  ParallelFailurePolicy,
  ParallelOptions,
} from "../../authoring/step/continuation.types.js";
import {
  isParallelNode,
  isStepNode,
  isWorkflowInvocationNode,
} from "../../authoring/step/step-node.js";
import type { WorkflowAgentRole } from "../../contracts/agents/agent-role.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import { readBranchRunState, writeBranchRunState } from "../artifacts/run-storage.js";
import { resolveStepArtifactPaths } from "../artifacts/step-artifacts.js";
import {
  type RunContinuationResult,
  runContinuation,
  type WaitingWait,
} from "../continuation/run-continuation/run-continuation.js";
import { createQueuedRunState } from "../run-context/create-run-context.js";
import { runContextStorage } from "../run-context/run-context-storage.js";
import type { TimeoutPolicyInput } from "../timeout/timeout-policy.js";
import type {
  Event,
  RunWorkflowOptions,
  RunWorkflowTrackRetryOptions,
} from "./run-workflow.types.js";

interface RunRootContinuationArraySchedulerOptions {
  readonly nodes: readonly ContinuationResult[];
  readonly rootIsArray?: boolean;
  readonly runId: string;
  readonly workflowId: string;
  readonly emit: (event: Event) => Promise<void>;
  readonly maxSteps: number;
  readonly initialSource: string;
  readonly workers?: number;
  readonly workflowAgents: Readonly<Record<string, WorkflowAgentRole>>;
  readonly workflowTimeout?: TimeoutPolicyInput;
  readonly runDir: string;
  readonly projectCwd?: string;
  readonly cwd: string;
  readonly trailstepConfig?: TrailStepConfig;
  readonly workingAgentProcessRunner?: RunWorkflowOptions["workingAgentProcessRunner"];
  readonly providerWorkingRunner?: RunWorkflowOptions["providerWorkingRunner"];
  readonly processRunner?: RunWorkflowOptions["processRunner"];
  readonly retry?: {
    readonly initialExecutedSteps: number;
    readonly track?: RunWorkflowTrackRetryOptions;
  };
}

type BranchStatus = "queued" | "running" | "done" | "failed" | "waiting" | "cancelled" | "split";
type TrackTerminalKind = "absoluteDone" | "absoluteFail" | "failure" | "waiting" | "cancelled";
type AbsoluteTerminalKind = "absoluteDone" | "absoluteFail";

interface TrackStateJson {
  readonly runId: string;
  readonly status: string;
  readonly workers: number;
  readonly failurePolicy: "fail-fast";
  readonly rootBranchId: string;
  readonly splitOccurred: boolean;
  readonly branches: readonly string[];
  readonly terminalBranchId?: string;
  readonly terminalKind?: TrackTerminalKind;
  readonly terminalOutput?: PlainObject;
  readonly failure?: Failure;
}

interface BranchState {
  readonly branchId: string;
  readonly parentBranchId?: string;
  readonly requestedBranchId?: string;
  readonly joinContinuation?: boolean;
  pendingPostJoin?: boolean;
  readonly workflowId: string;
  readonly createdAt: string;
  status: BranchStatus;
  output?: PlainObject;
  failure?: Failure;
  wait?: WaitingWait;
  terminalKind?: AbsoluteTerminalKind;
  message?: string;
  source: string;
  splitSource?: string;
  updatedAt: string;
  latestStepIndex: number;
  latestStepId?: string;
}

interface PendingJoin {
  readonly parentBranchId: string;
  readonly childBranchIds: readonly string[];
  readonly source: string;
  readonly failurePolicy: ParallelFailurePolicy;
  readonly postContinuation: (
    output: PlainObject,
  ) => ContinuationResult | Promise<ContinuationResult>;
  readonly afterPostContinuation?: (
    output: PlainObject,
  ) => ContinuationResult | Promise<ContinuationResult>;
  completed: Readonly<Record<string, PlainObject>>;
}

interface BranchStateJson {
  readonly branchId: string;
  readonly parentBranchId?: string;
  readonly requestedBranchId?: string;
  readonly joinContinuation?: boolean;
  readonly pendingPostJoin?: boolean;
  readonly status: BranchStatus;
  readonly workflowId: string;
  readonly source: string;
  readonly splitSource?: string;
  readonly output: PlainObject;
  readonly failure?: Failure;
  readonly wait?: WaitingWait;
  readonly terminalKind?: AbsoluteTerminalKind;
  readonly message?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestStepIndex: number;
  readonly latestStepId?: string;
}

interface QueuedBranch {
  readonly node: ContinuationResult;
  readonly branch: BranchState;
  readonly source: string;
  readonly requireRunnableBranchCandidate: boolean;
  readonly parallelGroupId?: string;
  readonly parallelConcurrency?: number;
  readonly failurePolicy: ParallelFailurePolicy;
}

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
  let splitOccurred = options.rootIsArray === true;
  let nextStepIndex = options.retry?.initialExecutedSteps ?? 0;
  let nextBranchId = 1;
  let terminalResult: RunContinuationResult | undefined;
  let terminalBranchId: string | undefined;
  let terminalKind: TrackTerminalKind | undefined;
  const pendingJoins: PendingJoin[] = [];
  const activeByParallelGroup = new Map<string, number>();

  const allocateStepIndex = (branch: BranchState): number => {
    if (nextStepIndex >= options.maxSteps) {
      throw new Error(`workflow exceeded maxSteps guard (${options.maxSteps})`);
    }
    nextStepIndex += 1;
    branch.latestStepIndex = nextStepIndex;
    branch.updatedAt = new Date().toISOString();
    return nextStepIndex;
  };

  const allocateBranchId = (node: ContinuationResult): string => {
    const explicitBranchId = requestedBranchMetadata(node).requestedBranchId;
    if (explicitBranchId !== undefined) {
      return explicitBranchId;
    }

    const baseBranchId = branchIdBaseForNode(node);
    let suffix = 1;
    while (branches.some((branch) => branch.branchId === `${baseBranchId}-${suffix}`)) {
      suffix += 1;
    }
    nextBranchId = Math.max(nextBranchId, suffix + 1);
    return `${baseBranchId}-${suffix}`;
  };

  const enqueue = (
    node: ContinuationResult,
    parentBranchId: string | undefined,
    source: string,
    requireRunnableBranchCandidate: boolean,
    joinContinuation = false,
    scheduling?: {
      readonly parallelGroupId?: string;
      readonly parallelConcurrency?: number;
      readonly failurePolicy?: ParallelFailurePolicy;
    },
  ): BranchState => {
    const branch = createBranchRecord({
      node,
      parentBranchId,
      source,
      workflowId: workflowIdForBranchNode(node, options.workflowId),
      branchId:
        parentBranchId === undefined && branches.length === 0
          ? rootBranchId
          : allocateBranchId(node),
      joinContinuation,
    });
    branches.push(branch);
    if (terminalResult === undefined) {
      queue.push({
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
  };

  const cancelQueuedAndPreventableBranches = async (preservedBranchId?: string): Promise<void> => {
    queue.length = 0;
    await cancelPreventableBranches(branches, options.runDir, preservedBranchId);
  };

  const terminalizeTrack = async (
    result: RunContinuationResult,
    terminal?: { readonly branchId: string; readonly kind: TrackTerminalKind },
  ): Promise<void> => {
    if (terminalResult === undefined) {
      terminalResult = result;
      terminalBranchId = terminal?.branchId;
      terminalKind = terminal?.kind;
      await cancelQueuedAndPreventableBranches(terminal?.branchId);
    }
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
    splitOccurred = retryPlan.splitOccurred;
    nextBranchId = retryPlan.nextBranchId;
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
      enqueue(node, rootBranchId, options.initialSource, true);
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
    enqueue(rootNode, undefined, options.initialSource, false);
  }

  await persistTrack(options, workers, rootBranchId, branches, "running", splitOccurred);

  let activeWorkers = 0;

  await new Promise<void>((resolve, reject) => {
    const schedule = (): void => {
      if (terminalResult !== undefined || queue.length === 0) {
        if (activeWorkers === 0) {
          resolve();
        }
        return;
      }

      while (terminalResult === undefined && activeWorkers < workers && queue.length > 0) {
        const queued = shiftRunnableQueuedBranch(queue, activeByParallelGroup);
        if (queued === undefined) {
          if (activeWorkers === 0) {
            resolve();
          }
          return;
        }
        activeWorkers += 1;
        incrementActiveParallelGroup(queued.parallelGroupId, activeByParallelGroup);

        void runBranch(queued)
          .then(async (branchResult) => {
            if (branchResult.status !== "success") {
              await terminalizeTrack(branchResult);
            }
          })
          .then(
            () => {
              activeWorkers -= 1;
              decrementActiveParallelGroup(queued.parallelGroupId, activeByParallelGroup);
              schedule();
            },
            (error: unknown) => {
              reject(error);
            },
          );
      }
    };

    schedule();
  });

  if (terminalResult !== undefined) {
    await cancelQueuedAndPreventableBranches(terminalBranchId);
    await Promise.all(branches.map((branch) => persistBranch(options.runDir, branch)));
    await persistTrack(
      options,
      workers,
      rootBranchId,
      branches,
      trackStatusFromTerminalResult(terminalResult),
      splitOccurred,
      terminalResult.status === "failure" || terminalResult.status === "absoluteFailure"
        ? terminalResult.failure
        : undefined,
      terminalBranchId,
      terminalKind,
      terminalResult.status === "success" || terminalResult.status === "absoluteSuccess"
        ? terminalResult.output
        : undefined,
    );
    return publicTerminalResult(terminalResult);
  }

  await Promise.all(branches.map((branch) => persistBranch(options.runDir, branch)));
  await persistTrack(options, workers, rootBranchId, branches, "completed", splitOccurred);

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

  if (!splitOccurred && terminalBranches.length === 1 && terminalBranches[0]?.status === "done") {
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

  async function runWithBranchState<T>(branchId: string, fn: () => Promise<T>): Promise<T> {
    const parentContext = runContextStorage.getStore();
    if (!parentContext || (!splitOccurred && branchId === rootBranchId)) {
      return await fn();
    }

    const branchContext = {
      ...parentContext,
      state: createQueuedRunState({
        read: () => readBranchRunState(options.runDir, branchId),
        write: (nextState) => writeBranchRunState(options.runDir, branchId, nextState),
      }),
    };
    return await runContextStorage.run(branchContext, fn);
  }

  async function runBranch(queued: QueuedBranch): Promise<RunContinuationResult> {
    const { node, branch, source, requireRunnableBranchCandidate, failurePolicy } = queued;
    if (requireRunnableBranchCandidate && !isRunnableBranchCandidate(node)) {
      branch.status = "failed";
      branch.updatedAt = new Date().toISOString();
      await persistBranch(options.runDir, branch);
      return invalidArrayCandidateFailure(source);
    }

    branch.status = "running";
    branch.updatedAt = new Date().toISOString();
    await persistBranch(options.runDir, branch);

    const branchResult = await runWithBranchState(branch.branchId, async () =>
      runContinuation({
        node,
        runId: options.runId,
        workflowId: options.workflowId,
        emit: async (event) => {
          if (event.type === "step.started" && event.stepId !== undefined) {
            branch.latestStepId = event.stepId;
          }
          if (splitOccurred && event.type === "step.started" && event.stepId !== undefined) {
            const stepArtifacts = resolveStepArtifactPaths({
              runDir: options.runDir,
              stepId: event.stepId,
              stepIndex: branch.latestStepIndex,
            });
            await mkdir(stepArtifacts.stepDir, { recursive: true });
          }
          await options.emit(decorateBranchEvent(event, options.runId, branch));
        },
        maxSteps: options.maxSteps,
        initialSource:
          !splitOccurred && branch.branchId === rootBranchId
            ? source
            : `${source} branch ${branch.branchId}`,
        allocateStepIndex: () => allocateStepIndex(branch),
        returnContinuationArrays: true,
        workflowAgents: options.workflowAgents,
        workflowTimeout: options.workflowTimeout,
        runDir: options.runDir,
        projectCwd: options.projectCwd,
        cwd: options.cwd,
        trailstepConfig: options.trailstepConfig,
        workingAgentProcessRunner: options.workingAgentProcessRunner,
        providerWorkingRunner: options.providerWorkingRunner,
        processRunner: options.processRunner,
      }),
    );

    branch.updatedAt = new Date().toISOString();
    const branchResultWasSplit = branchResult.status === "split";
    if (terminalResult !== undefined) {
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
      await terminalizeTrack(branchResult, { branchId: branch.branchId, kind: "absoluteDone" });
      await persistBranch(options.runDir, branch);
      return branchResult;
    }

    if (branchResult.status === "absoluteFailure") {
      branch.status = "failed";
      branch.failure = branchResult.failure;
      branch.message = branchResult.message;
      branch.terminalKind = "absoluteFail";
      await terminalizeTrack(branchResult, { branchId: branch.branchId, kind: "absoluteFail" });
      await persistBranch(options.runDir, branch);
      return branchResult;
    }

    if (branchResult.status === "failure") {
      branch.status = "failed";
      branch.failure = branchResult.failure;
      branch.message = branchResult.message;
      if (failurePolicy === "all-settled") {
        await enqueueSatisfiedJoins(branch);
        await persistBranch(options.runDir, branch);
        await persistTrack(options, workers, rootBranchId, branches, "running", splitOccurred);
        return { status: "success", output: {} };
      }
      await terminalizeTrack(branchResult, { branchId: branch.branchId, kind: "failure" });
      await persistBranch(options.runDir, branch);
      return branchResult;
    }

    if (branchResult.status === "waiting") {
      branch.status = "waiting";
      branch.wait = branchResult.wait;
      await terminalizeTrack(branchResult, { branchId: branch.branchId, kind: "waiting" });
      await persistBranch(options.runDir, branch);
      return branchResult;
    }

    if (branchResult.status === "cancelled") {
      branch.status = "cancelled";
      await terminalizeTrack(branchResult, { branchId: branch.branchId, kind: "cancelled" });
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
        branches,
      );
      if (duplicateBranchIdFailure !== undefined) {
        branch.status = "failed";
        branch.failure = duplicateBranchIdFailure.failure;
        await persistBranch(options.runDir, branch);
        return duplicateBranchIdFailure;
      }
      splitOccurred = true;
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
      if (terminalResult !== undefined) {
        branch.status = "cancelled";
        branch.updatedAt = new Date().toISOString();
        await persistBranch(options.runDir, branch);
        return { status: "cancelled", cancellation: { requestedAt: branch.updatedAt } };
      }
      const parallelOptions = normalizeParallelOptions(branchResult.parallelOptions);
      const childBranches = branchResult.nodes.map((childNode) =>
        enqueue(childNode, branch.branchId, branchResult.source, true, false, {
          parallelGroupId: branch.branchId,
          ...(parallelOptions.concurrency === undefined
            ? {}
            : { parallelConcurrency: parallelOptions.concurrency }),
          failurePolicy: parallelOptions.failurePolicy,
        }),
      );
      if (branchResult.postContinuation !== undefined) {
        branch.pendingPostJoin = true;
        pendingJoins.push({
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
        branches.map((persistedBranch) => persistBranch(options.runDir, persistedBranch)),
      );
    } else if (branchResult.status === "success") {
      branch.status = "done";
      branch.output = branchResult.output;
      branch.message = branchResult.message;
      await enqueueSatisfiedJoins(branch);
    }
    await persistBranch(options.runDir, branch);
    await persistTrack(options, workers, rootBranchId, branches, "running", splitOccurred);
    return branchResultWasSplit ? { status: "success", output: {} } : branchResult;
  }

  async function enqueueSatisfiedJoins(branch: BranchState): Promise<void> {
    for (const join of pendingJoins) {
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
        await terminalizeTrack({
          status: "failure",
          failure: {
            code: "step_execution_failed",
            message: `parallel post failed for ${join.source}: ${String(error)}`,
          },
        });
        continue;
      }
      const postBranch = enqueue(
        nextNode,
        join.parentBranchId,
        `post for ${join.source}`,
        false,
        true,
      );
      if (join.afterPostContinuation !== undefined) {
        const afterPostContinuation = join.afterPostContinuation;
        pendingJoins.push({
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
}

function createBranchRecord(input: {
  readonly node: ContinuationResult;
  readonly parentBranchId: string | undefined;
  readonly source: string;
  readonly workflowId: string;
  readonly branchId: string;
  readonly joinContinuation: boolean;
}): BranchState {
  const now = new Date().toISOString();
  return {
    branchId: input.branchId,
    ...(input.parentBranchId === undefined ? {} : { parentBranchId: input.parentBranchId }),
    ...(input.joinContinuation ? { joinContinuation: true } : {}),
    ...requestedBranchMetadata(input.node),
    workflowId: input.workflowId,
    createdAt: now,
    updatedAt: now,
    status: "queued",
    source: input.source,
    latestStepIndex: 0,
  };
}

function workflowIdForBranchNode(node: ContinuationResult, fallbackWorkflowId: string): string {
  if (isWorkflowInvocationNode(node)) {
    return node.workflow.id;
  }

  return fallbackWorkflowId;
}

function requestedBranchMetadata(node: ContinuationResult): {
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

function branchIdBaseForNode(node: ContinuationResult): string {
  const rawId = isWorkflowInvocationNode(node)
    ? node.workflow.id
    : isStepNode(node)
      ? node.config.id
      : "branch";
  return rawId.replaceAll(/[^A-Za-z0-9._-]/g, "-") || "branch";
}

function explicitDuplicateBranchIdFailure(
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

function isRunnableBranchCandidate(node: ContinuationResult): boolean {
  return isStepNode(node) || isWorkflowInvocationNode(node);
}

function invalidArrayCandidateFailure(
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

function isBranchTerminalStatus(status: BranchStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

function normalizeParallelOptions(options: ParallelOptions | undefined): {
  readonly concurrency?: number;
  readonly failurePolicy: ParallelFailurePolicy;
} {
  const concurrency = options?.concurrency;
  return {
    ...(concurrency === undefined ? {} : { concurrency }),
    failurePolicy: options?.failurePolicy ?? "fail-fast",
  };
}

function shiftRunnableQueuedBranch(
  queue: QueuedBranch[],
  activeByParallelGroup: ReadonlyMap<string, number>,
): QueuedBranch | undefined {
  const index = queue.findIndex((candidate) => {
    if (candidate.parallelGroupId === undefined || candidate.parallelConcurrency === undefined) {
      return true;
    }
    return (
      (activeByParallelGroup.get(candidate.parallelGroupId) ?? 0) < candidate.parallelConcurrency
    );
  });
  if (index < 0) {
    return undefined;
  }
  const [queued] = queue.splice(index, 1);
  return queued;
}

function incrementActiveParallelGroup(
  parallelGroupId: string | undefined,
  activeByParallelGroup: Map<string, number>,
): void {
  if (parallelGroupId === undefined) {
    return;
  }
  activeByParallelGroup.set(parallelGroupId, (activeByParallelGroup.get(parallelGroupId) ?? 0) + 1);
}

function decrementActiveParallelGroup(
  parallelGroupId: string | undefined,
  activeByParallelGroup: Map<string, number>,
): void {
  if (parallelGroupId === undefined) {
    return;
  }
  const next = (activeByParallelGroup.get(parallelGroupId) ?? 1) - 1;
  if (next <= 0) {
    activeByParallelGroup.delete(parallelGroupId);
  } else {
    activeByParallelGroup.set(parallelGroupId, next);
  }
}

function branchSettlementForJoin(
  branch: BranchState,
  failurePolicy: ParallelFailurePolicy,
): PlainObject | undefined {
  if (failurePolicy === "all-settled") {
    return branchSettlementForSummary(branch);
  }
  return branch.status === "done" && branch.output !== undefined ? branch.output : undefined;
}

function branchSettlementForSummary(branch: BranchState): PlainObject {
  if (branch.status === "failed") {
    return {
      status: "failed",
      ...(branch.failure === undefined ? {} : { failure: branch.failure }),
      ...(branch.message === undefined ? {} : { message: branch.message }),
    };
  }

  return {
    status: branch.status,
    output: branch.output ?? {},
    ...(branch.message === undefined ? {} : { message: branch.message }),
  };
}

function trackStatusFromTerminalResult(result: RunContinuationResult): string {
  if (result.status === "failure" || result.status === "absoluteFailure") {
    return "failed";
  }
  if (result.status === "absoluteSuccess") {
    return "completed";
  }
  return result.status;
}

function publicTerminalResult(result: RunContinuationResult): RunContinuationResult {
  if (result.status === "absoluteSuccess") {
    return {
      status: "success",
      output: result.output,
      ...(result.message === undefined ? {} : { message: result.message }),
    };
  }

  if (result.status === "absoluteFailure") {
    return {
      status: "failure",
      failure: result.failure,
      ...(result.message === undefined ? {} : { message: result.message }),
    };
  }

  return result;
}

async function cancelPreventableBranches(
  branches: readonly BranchState[],
  runDir: string,
  preservedBranchId?: string,
): Promise<void> {
  const now = new Date().toISOString();
  await Promise.all(
    branches.map((branch) => {
      if (branch.branchId !== preservedBranchId && !isBranchTerminalStatus(branch.status)) {
        branch.status = "cancelled";
        branch.updatedAt = now;
      }
      return persistBranch(runDir, branch);
    }),
  );
}

function resolveSchedulerWorkerCount(
  workers: number | undefined,
):
  | { readonly ok: true; readonly workers: number }
  | { readonly ok: false; readonly failure: RunContinuationResult } {
  if (workers === undefined) {
    return {
      ok: true,
      workers: Math.max(1, Math.floor(availableParallelism() / 2)),
    };
  }

  if (!Number.isFinite(workers) || !Number.isInteger(workers) || workers < 1) {
    return {
      ok: false,
      failure: {
        status: "failure",
        failure: {
          code: "invalid_scheduler_workers",
          message: "scheduler.workers must be an integer greater than or equal to 1.",
        },
      },
    };
  }

  return { ok: true, workers };
}

function decorateBranchEvent(event: Event, trackId: string, branch: BranchState): Event {
  if (event.type !== "step.started" && event.type !== "step.completed") {
    return event;
  }

  const stepArtifactPaths =
    event.stepId === undefined || branch.latestStepIndex < 1
      ? undefined
      : resolveStepArtifactPaths({
          runDir: "",
          stepId: event.stepId,
          stepIndex: branch.latestStepIndex,
        });

  return {
    ...event,
    payload: {
      ...event.payload,
      trackId,
      branchId: branch.branchId,
      ...(branch.requestedBranchId === undefined
        ? {}
        : { requestedBranchId: branch.requestedBranchId }),
      ...(stepArtifactPaths === undefined
        ? {}
        : {
            stepIndex: branch.latestStepIndex,
            stepArtifactId: stepArtifactPaths.artifactStepId,
            stepArtifactPath: stepArtifactPaths.runRelativeStepDir,
          }),
    },
  };
}

async function createPersistedTrackRetryPlan(input: {
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
          message: `Retry target track metadata is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
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
    branch.wait = undefined;
    branch.terminalKind = undefined;
    branch.message = undefined;
    branch.updatedAt = new Date().toISOString();
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

function unsupportedPostJoinRetryFailure(): RunContinuationResult {
  return {
    status: "failure",
    failure: {
      code: "retry_parallel_post_join_unsupported",
      message:
        "Retrying parallel tracks with pending or completed parallel .post joins is not yet supported; restart the workflow instead.",
    },
  };
}

function selectPersistedBranchesForRetry(
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

function branchFromJson(json: BranchStateJson): BranchState {
  return {
    branchId: json.branchId,
    ...(json.parentBranchId === undefined ? {} : { parentBranchId: json.parentBranchId }),
    ...(json.requestedBranchId === undefined ? {} : { requestedBranchId: json.requestedBranchId }),
    ...(json.joinContinuation === undefined ? {} : { joinContinuation: json.joinContinuation }),
    ...(json.pendingPostJoin === undefined ? {} : { pendingPostJoin: json.pendingPostJoin }),
    workflowId: json.workflowId,
    createdAt: json.createdAt,
    updatedAt: json.updatedAt,
    status: json.status,
    source: json.source,
    ...(json.splitSource === undefined ? {} : { splitSource: json.splitSource }),
    output: json.output,
    ...(json.failure === undefined ? {} : { failure: json.failure }),
    ...(json.wait === undefined ? {} : { wait: json.wait }),
    ...(json.terminalKind === undefined ? {} : { terminalKind: json.terminalKind }),
    ...(json.message === undefined ? {} : { message: json.message }),
    latestStepIndex: json.latestStepIndex,
    ...(json.latestStepId === undefined ? {} : { latestStepId: json.latestStepId }),
  };
}

async function persistTrack(
  options: RunRootContinuationArraySchedulerOptions,
  workers: number,
  rootBranchId: string,
  branches: readonly BranchState[],
  status: string,
  splitOccurred: boolean,
  failure?: Failure,
  terminalBranchId?: string,
  terminalKind?: TrackTerminalKind,
  terminalOutput?: PlainObject,
): Promise<void> {
  const trackState: TrackStateJson = {
    runId: options.runId,
    status,
    workers,
    failurePolicy: "fail-fast",
    rootBranchId,
    splitOccurred,
    branches: branches.map((branch) => branch.branchId),
    ...(terminalBranchId === undefined ? {} : { terminalBranchId }),
    ...(terminalKind === undefined ? {} : { terminalKind }),
    ...(terminalOutput === undefined ? {} : { terminalOutput }),
    ...(failure === undefined ? {} : { failure }),
  };
  await writeJson(join(options.runDir, "track.json"), trackState);
}

async function persistBranch(runDir: string, branch: BranchState): Promise<void> {
  const branchState: BranchStateJson = {
    branchId: branch.branchId,
    ...(branch.parentBranchId === undefined ? {} : { parentBranchId: branch.parentBranchId }),
    ...(branch.requestedBranchId === undefined
      ? {}
      : { requestedBranchId: branch.requestedBranchId }),
    ...(branch.joinContinuation === undefined ? {} : { joinContinuation: branch.joinContinuation }),
    ...(branch.pendingPostJoin === undefined ? {} : { pendingPostJoin: branch.pendingPostJoin }),
    status: branch.status,
    workflowId: branch.workflowId,
    source: branch.source,
    ...(branch.splitSource === undefined ? {} : { splitSource: branch.splitSource }),
    output: branch.output ?? {},
    ...(branch.failure === undefined ? {} : { failure: branch.failure }),
    ...(branch.wait === undefined ? {} : { wait: branch.wait }),
    ...(branch.terminalKind === undefined ? {} : { terminalKind: branch.terminalKind }),
    ...(branch.message === undefined ? {} : { message: branch.message }),
    createdAt: branch.createdAt,
    updatedAt: branch.updatedAt,
    latestStepIndex: branch.latestStepIndex,
    ...(branch.latestStepId === undefined ? {} : { latestStepId: branch.latestStepId }),
  };
  await writeJson(join(runDir, "branches", `${branch.branchId}.json`), branchState);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
