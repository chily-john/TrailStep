import type { TrailStepConfig } from "../../agent-targeting/targeting.types.js";
import type {
  ContinuationResult,
  ParallelFailurePolicy,
} from "../../authoring/step/continuation.types.js";
import type { WorkflowAgentRole } from "../../contracts/agents/agent-role.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type {
  ResumeWaitOptions,
  RunContinuationResult,
  WaitingWait,
} from "../continuation/run-continuation/run-continuation.js";
import type { RetryPolicyInput } from "../retry/retry-policy.js";
import type { TimeoutPolicyInput } from "../timeout/timeout-policy.js";
import type {
  Event,
  RunWorkflowOptions,
  RunWorkflowTrackRetryOptions,
} from "./run-workflow.types.js";

export interface RunRootContinuationArraySchedulerOptions {
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
  /** Workflow-level retry tier forwarded to each branch's continuation. */
  readonly workflowRetry?: RetryPolicyInput;
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
  readonly waitResumeBranches?: Readonly<Record<string, ResumeWaitOptions>>;
}

export type BranchStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "waiting"
  | "cancelled"
  | "split";
export type TrackTerminalKind =
  | "absoluteDone"
  | "absoluteFail"
  | "failure"
  | "waiting"
  | "cancelled";
export type AbsoluteTerminalKind = "absoluteDone" | "absoluteFail";

export interface TrackStateJson {
  readonly runId: string;
  readonly status: string;
  readonly workers: number;
  readonly failurePolicy: "fail-fast";
  readonly rootBranchId: string;
  readonly splitOccurred: boolean;
  readonly branches: readonly string[];
  /** OS process driving the run; used to detect orphaned "running" tracks. */
  readonly ownerPid?: number;
  readonly terminalBranchId?: string;
  readonly terminalKind?: TrackTerminalKind;
  readonly terminalOutput?: PlainObject;
  readonly failure?: Failure;
}

export interface BranchState {
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

export interface PendingJoin {
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

export interface BranchStateJson {
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

export interface QueuedBranch {
  readonly node: ContinuationResult;
  readonly branch: BranchState;
  readonly source: string;
  readonly requireRunnableBranchCandidate: boolean;
  readonly parallelGroupId?: string;
  readonly parallelConcurrency?: number;
  readonly failurePolicy: ParallelFailurePolicy;
}

/**
 * Mutable state shared by the scheduler entry point and its focused helpers.
 * The persisted `track.json` / `branches/*.json` artifact shapes are defined
 * by `TrackStateJson` / `BranchStateJson` and must not change.
 */
export interface SchedulerRuntime {
  readonly options: RunRootContinuationArraySchedulerOptions;
  readonly branches: BranchState[];
  readonly queue: QueuedBranch[];
  readonly pendingJoins: PendingJoin[];
  readonly activeByParallelGroup: Map<string, number>;
  workers: number;
  rootBranchId: string;
  splitOccurred: boolean;
  nextStepIndex: number;
  nextBranchId: number;
  terminalResult: RunContinuationResult | undefined;
  terminalBranchId: string | undefined;
  terminalKind: TrackTerminalKind | undefined;
}

export type SchedulerBranchScheduling = {
  readonly parallelGroupId?: string;
  readonly parallelConcurrency?: number;
  readonly failurePolicy?: ParallelFailurePolicy;
};

export type NormalizedParallelOptions = {
  readonly concurrency?: number;
  readonly failurePolicy: ParallelFailurePolicy;
};
