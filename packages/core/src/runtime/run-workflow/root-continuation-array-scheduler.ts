import { mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { TrailStepConfig } from "../../agent-targeting/targeting.types.js";
import type { ContinuationResult } from "../../authoring/step/continuation.types.js";
import { isStepNode, isWorkflowInvocationNode } from "../../authoring/step/step-node.js";
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

interface BranchStateJson {
  readonly branchId: string;
  readonly parentBranchId?: string;
  readonly requestedBranchId?: string;
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

  const allocateStepIndex = (branch: BranchState): number => {
    if (nextStepIndex >= options.maxSteps) {
      throw new Error(`workflow exceeded maxSteps guard (${options.maxSteps})`);
    }
    nextStepIndex += 1;
    branch.latestStepIndex = nextStepIndex;
    branch.updatedAt = new Date().toISOString();
    return nextStepIndex;
  };

  const enqueue = (
    node: ContinuationResult,
    parentBranchId: string | undefined,
    source: string,
    requireRunnableBranchCandidate: boolean,
  ): BranchState => {
    const branch = createBranchRecord({
      node,
      parentBranchId,
      source,
      workflowId: workflowIdForBranchNode(node, options.workflowId),
      branchId:
        parentBranchId === undefined && branches.length === 0
          ? rootBranchId
          : `branch-${nextBranchId++}`,
    });
    branches.push(branch);
    if (terminalResult === undefined) {
      queue.push({ node, branch, source, requireRunnableBranchCandidate });
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
        const queued = queue.shift();
        if (queued === undefined) {
          return;
        }
        activeWorkers += 1;

        void runBranch(queued)
          .then(async (branchResult) => {
            if (branchResult.status !== "success") {
              await terminalizeTrack(branchResult);
            }
          })
          .then(
            () => {
              activeWorkers -= 1;
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
        terminalBranches.map((branch) => [
          branch.branchId,
          {
            status: branch.status,
            output: branch.output ?? {},
          },
        ]),
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
    const { node, branch, source, requireRunnableBranchCandidate } = queued;
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
      for (const childNode of branchResult.nodes) {
        enqueue(childNode, branch.branchId, branchResult.source, true);
      }
      await Promise.all(
        branches.map((persistedBranch) => persistBranch(options.runDir, persistedBranch)),
      );
    } else if (branchResult.status === "success") {
      branch.status = "done";
      branch.output = branchResult.output;
      branch.message = branchResult.message;
    }
    await persistBranch(options.runDir, branch);
    await persistTrack(options, workers, rootBranchId, branches, "running", splitOccurred);
    return branchResultWasSplit ? { status: "success", output: {} } : branchResult;
  }
}

function createBranchRecord(input: {
  readonly node: ContinuationResult;
  readonly parentBranchId: string | undefined;
  readonly source: string;
  readonly workflowId: string;
  readonly branchId: string;
}): BranchState {
  const now = new Date().toISOString();
  return {
    branchId: input.branchId,
    ...(input.parentBranchId === undefined ? {} : { parentBranchId: input.parentBranchId }),
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
  if (isWorkflowInvocationNode(node) && node.options?.branch !== undefined) {
    return { requestedBranchId: node.options.branch };
  }

  return {};
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

  if (!input.nodes.every(isRunnableBranchCandidate)) {
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
  const nodesByRequestedBranchId = new Map<string, ContinuationResult>();
  for (const node of input.nodes) {
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

    branch.status = "queued";
    branch.failure = undefined;
    branch.wait = undefined;
    branch.terminalKind = undefined;
    branch.message = undefined;
    branch.updatedAt = new Date().toISOString();
    const node =
      (branch.requestedBranchId === undefined
        ? undefined
        : nodesByRequestedBranchId.get(branch.requestedBranchId)) ?? input.nodes[index];
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
          .filter((branch) => !(branch.status === "done" && branch.output !== undefined))
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
