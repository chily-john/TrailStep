import { join } from "node:path";
import type {
  ContinuationResult,
  ParallelFailurePolicy,
} from "../../authoring/step/continuation.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import { atomicWriteJson } from "../artifacts/run-storage.js";
import type { RunContinuationResult } from "../continuation/run-continuation/run-continuation.js";
import { requestedBranchMetadata } from "./scheduler-branch-identity.js";
import type {
  BranchState,
  BranchStateJson,
  BranchStatus,
  RunRootContinuationArraySchedulerOptions,
  TrackStateJson,
  TrackTerminalKind,
} from "./scheduler-types.js";

export function createBranchRecord(input: {
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

export function branchFromJson(json: BranchStateJson): BranchState {
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

export async function persistTrack(
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
    ownerPid: process.pid,
    ...(terminalBranchId === undefined ? {} : { terminalBranchId }),
    ...(terminalKind === undefined ? {} : { terminalKind }),
    ...(terminalOutput === undefined ? {} : { terminalOutput }),
    ...(failure === undefined ? {} : { failure }),
  };
  await atomicWriteJson(join(options.runDir, "track.json"), trackState);
}

export async function persistBranch(runDir: string, branch: BranchState): Promise<void> {
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
  await atomicWriteJson(join(runDir, "branches", `${branch.branchId}.json`), branchState);
}

export function isBranchTerminalStatus(status: BranchStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

export function branchSettlementForJoin(
  branch: BranchState,
  failurePolicy: ParallelFailurePolicy,
): PlainObject | undefined {
  if (failurePolicy === "all-settled") {
    return branchSettlementForSummary(branch);
  }
  return branch.status === "done" && branch.output !== undefined ? branch.output : undefined;
}

export function branchSettlementForSummary(branch: BranchState): PlainObject {
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

export function trackStatusFromTerminalResult(result: RunContinuationResult): string {
  if (result.status === "failure" || result.status === "absoluteFailure") {
    return "failed";
  }
  if (result.status === "absoluteSuccess") {
    return "completed";
  }
  return result.status;
}

export function publicTerminalResult(result: RunContinuationResult): RunContinuationResult {
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

export async function cancelPreventableBranches(
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
