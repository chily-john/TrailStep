import { mkdir, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { TrailStepConfig } from "../../agent-targeting/targeting.types.js";
import type { ContinuationResult } from "../../authoring/step/continuation.types.js";
import { isStepNode, isWorkflowInvocationNode } from "../../authoring/step/step-node.js";
import type { WorkflowAgentRole } from "../../contracts/agents/agent-role.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import { resolveStepArtifactPaths } from "../artifacts/step-artifacts.js";
import {
  type RunContinuationResult,
  runContinuation,
} from "../continuation/run-continuation/run-continuation.js";
import type { TimeoutPolicyInput } from "../timeout/timeout-policy.js";
import type { Event, RunWorkflowOptions } from "./run-workflow.types.js";

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
}

type BranchStatus = "queued" | "running" | "done" | "failed" | "waiting" | "cancelled" | "split";

interface BranchState {
  readonly branchId: string;
  readonly parentBranchId?: string;
  readonly requestedBranchId?: string;
  readonly workflowId: string;
  readonly createdAt: string;
  status: BranchStatus;
  output?: PlainObject;
  failure?: Failure;
  message?: string;
  source: string;
  splitSource?: string;
  updatedAt: string;
  latestStepIndex: number;
  latestStepId?: string;
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
  let nextStepIndex = 0;
  let nextBranchId = 1;

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
      workflowId: options.workflowId,
      branchId:
        parentBranchId === undefined && branches.length === 0
          ? rootBranchId
          : `branch-${nextBranchId++}`,
    });
    branches.push(branch);
    queue.push({ node, branch, source, requireRunnableBranchCandidate });
    return branch;
  };

  const cancelQueuedAndPreventableBranches = async (): Promise<void> => {
    queue.length = 0;
    await cancelPreventableBranches(branches, options.runDir);
  };

  if (options.rootIsArray === true) {
    if (!options.nodes.every(isRunnableBranchCandidate)) {
      return unsupportedArrayFailure(options.initialSource);
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
  let terminalResult: RunContinuationResult | undefined;

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
            if (branchResult.status !== "success" && terminalResult === undefined) {
              terminalResult = branchResult;
              await cancelQueuedAndPreventableBranches();
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
    await cancelQueuedAndPreventableBranches();
    await Promise.all(branches.map((branch) => persistBranch(options.runDir, branch)));
    await persistTrack(
      options,
      workers,
      rootBranchId,
      branches,
      trackStatusFromTerminalResult(terminalResult),
      splitOccurred,
      terminalResult.status === "failure" ? terminalResult.failure : undefined,
    );
    return terminalResult;
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

  async function runBranch(queued: QueuedBranch): Promise<RunContinuationResult> {
    const { node, branch, source, requireRunnableBranchCandidate } = queued;
    if (requireRunnableBranchCandidate && !isRunnableBranchCandidate(node)) {
      branch.status = "failed";
      branch.updatedAt = new Date().toISOString();
      await persistBranch(options.runDir, branch);
      return unsupportedArrayFailure(source);
    }

    branch.status = "running";
    branch.updatedAt = new Date().toISOString();
    await persistBranch(options.runDir, branch);

    const branchResult = await runContinuation({
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
    });

    branch.updatedAt = new Date().toISOString();
    if (terminalResult !== undefined) {
      if (!isBranchTerminalStatus(branch.status)) {
        branch.status = "cancelled";
        branch.updatedAt = new Date().toISOString();
      }
      await persistBranch(options.runDir, branch);
      return { status: "cancelled", cancellation: { requestedAt: branch.updatedAt } };
    }

    if (branchResult.status === "split") {
      if (!branchResult.nodes.every(isRunnableBranchCandidate)) {
        branch.status = "failed";
        await persistBranch(options.runDir, branch);
        return unsupportedArrayFailure(branchResult.source);
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
      for (const childNode of branchResult.nodes) {
        enqueue(childNode, branch.branchId, branchResult.source, true);
      }
    } else if (branchResult.status === "success") {
      branch.status = "done";
      branch.output = branchResult.output;
      branch.message = branchResult.message;
    } else if (branchResult.status === "failure") {
      branch.status = "failed";
      branch.failure = branchResult.failure;
      branch.message = branchResult.message;
    } else {
      branch.status = branchResult.status;
    }
    await persistBranch(options.runDir, branch);
    await persistTrack(options, workers, rootBranchId, branches, "running", splitOccurred);
    return branchResult.status === "split" ? { status: "success", output: {} } : branchResult;
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

function requestedBranchMetadata(
  node: ContinuationResult,
): { readonly requestedBranchId?: string } {
  if (isWorkflowInvocationNode(node) && node.options?.branch !== undefined) {
    return { requestedBranchId: node.options.branch };
  }

  return {};
}

function isRunnableBranchCandidate(node: ContinuationResult): boolean {
  return isStepNode(node) || isWorkflowInvocationNode(node);
}

function unsupportedArrayFailure(source: string): RunContinuationResult {
  return {
    status: "failure",
    failure: {
      code: "unsupported_continuation",
      message: `${source} returned a continuation array containing unsupported branch candidates.`,
    },
  };
}

function isBranchTerminalStatus(status: BranchStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

function trackStatusFromTerminalResult(result: RunContinuationResult): string {
  if (result.status === "failure") {
    return "failed";
  }
  return result.status;
}

async function cancelPreventableBranches(
  branches: readonly BranchState[],
  runDir: string,
): Promise<void> {
  const now = new Date().toISOString();
  await Promise.all(
    branches.map((branch) => {
      if (!isBranchTerminalStatus(branch.status)) {
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

  return {
    ...event,
    payload: {
      ...event.payload,
      trackId,
      branchId: branch.branchId,
      ...(branch.requestedBranchId === undefined
        ? {}
        : { requestedBranchId: branch.requestedBranchId }),
    },
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
): Promise<void> {
  await writeJson(join(options.runDir, "track.json"), {
    runId: options.runId,
    status,
    workers,
    failurePolicy: "fail-fast",
    rootBranchId,
    splitOccurred,
    branches: branches.map((branch) => branch.branchId),
    ...(failure === undefined ? {} : { failure }),
  });
}

async function persistBranch(runDir: string, branch: BranchState): Promise<void> {
  await writeJson(join(runDir, "branches", `${branch.branchId}.json`), {
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
    ...(branch.message === undefined ? {} : { message: branch.message }),
    createdAt: branch.createdAt,
    updatedAt: branch.updatedAt,
    latestStepIndex: branch.latestStepIndex,
    ...(branch.latestStepId === undefined ? {} : { latestStepId: branch.latestStepId }),
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
