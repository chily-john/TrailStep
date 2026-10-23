import type { TrailStepConfig } from "../../../agent-targeting/targeting.types.js";
import type { normalizeShape } from "../../../authoring/shape/json-schema.js";
import type {
  ContinuationResult,
  ParallelOptions,
} from "../../../authoring/step/continuation.types.js";
import type { WorkflowAgentRole } from "../../../contracts/agents/agent-role.types.js";
import type { Failure } from "../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import type { WaitArtifactPaths } from "../../artifacts/step-artifacts.js";
import type { CancellationMarker } from "../../cancellation/cancellation.js";
import type { RetryPolicyInput } from "../../retry/retry-policy.js";
import type { Event, RunWorkflowOptions } from "../../run-workflow/run-workflow.types.js";
import type { TimeoutPolicyInput } from "../../timeout/timeout-policy.js";

export interface RunContinuationOptions {
  readonly node: ContinuationResult;
  readonly runId: string;
  readonly workflowId: string;
  readonly emit: (event: Event) => Promise<void>;
  readonly maxSteps: number;
  readonly initialSource: string;
  readonly initialExecutedSteps?: number;
  readonly allocateStepIndex?: () => number;
  readonly workflowAgents: Readonly<Record<string, WorkflowAgentRole>>;
  readonly workflowTimeout?: TimeoutPolicyInput;
  /**
   * Workflow-level retry tier (from `Workflow.retry`) applied when a step does
   * not configure its own `retry`. Follows the same resolution order as
   * timeouts: step > workflow > global (`settings.retry`).
   */
  readonly workflowRetry?: RetryPolicyInput;
  readonly runDir: string;
  readonly projectCwd?: string;
  readonly cwd: string;
  readonly trailstepConfig?: TrailStepConfig;
  readonly workingAgentProcessRunner?: RunWorkflowOptions["workingAgentProcessRunner"];
  readonly providerWorkingRunner?: RunWorkflowOptions["providerWorkingRunner"];
  readonly processRunner?: RunWorkflowOptions["processRunner"];
  readonly resumeWait?: ResumeWaitOptions;
  readonly returnContinuationArrays?: boolean;
}

export interface ResumeWaitOptions {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly phaseIndex: number;
  readonly phaseValue: PlainObject;
  readonly waitOutputs: Readonly<Record<string, PlainObject>>;
  readonly seenWaitIds: readonly string[];
  readonly wait: ResumedWaitDetails;
  /**
   * Resolved continuation node to resume from (for branch-scoped waits this is
   * the waiting step node resolved out of the parallel start tree). When absent,
   * the caller resumes from the node it would otherwise run from.
   */
  readonly startNode?: ContinuationResult;
}

type WaitKind = "input" | "check";

export interface ResumedWaitDetails {
  readonly waitId: string;
  readonly kind: WaitKind;
  readonly message: string;
  readonly artifactPaths: WaitArtifactPaths;
  readonly outputSchema: Record<string, unknown>;
}

export interface WaitingWait {
  readonly stepId: string;
  readonly waitId: string;
  readonly kind?: WaitKind;
  readonly message: string;
  readonly retryAfterSeconds?: number;
  readonly artifactPaths: WaitArtifactPaths;
}

export interface WorkflowInvocationFrame {
  readonly workflowId: string;
  readonly workflowAgents: Readonly<Record<string, WorkflowAgentRole>>;
  readonly workflowTimeout?: TimeoutPolicyInput;
  readonly workflowRetry?: RetryPolicyInput;
  readonly workflowOutputSchema?: ReturnType<typeof normalizeShape>;
  readonly invocationWorkflowId: string;
  readonly postContinuation?: (
    output: PlainObject,
  ) => ContinuationResult | Promise<ContinuationResult>;
}

export type ContinuationPostHandler = (
  output: PlainObject,
) => ContinuationResult | Promise<ContinuationResult>;

export type StepPostContinuations = {
  readonly postContinuation?: ContinuationPostHandler;
  readonly afterPostContinuation?: ContinuationPostHandler;
};

export type RunContinuationResult =
  | { readonly status: "success"; readonly output: PlainObject; readonly message?: string }
  | { readonly status: "failure"; readonly failure: Failure; readonly message?: string }
  | { readonly status: "absoluteSuccess"; readonly output: PlainObject; readonly message?: string }
  | { readonly status: "absoluteFailure"; readonly failure: Failure; readonly message?: string }
  | { readonly status: "waiting"; readonly wait: WaitingWait }
  | { readonly status: "cancelled"; readonly cancellation: CancellationMarker }
  | {
      readonly status: "split";
      readonly nodes: readonly ContinuationResult[];
      readonly source: string;
      readonly parallelOptions?: ParallelOptions;
      readonly postContinuation?: (
        output: PlainObject,
      ) => ContinuationResult | Promise<ContinuationResult>;
      readonly afterPostContinuation?: (
        output: PlainObject,
      ) => ContinuationResult | Promise<ContinuationResult>;
    };
