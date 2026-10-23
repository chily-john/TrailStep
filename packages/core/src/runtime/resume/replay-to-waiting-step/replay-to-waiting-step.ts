import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepNode } from "../../../authoring/step/continuation.types.js";
import type { Failure } from "../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import { errorMessage, isPlainObject } from "../../../json/guards.js";
import { readPlainPayload } from "../../../runtime/events/read-plain-payload.js";
import type {
  Event,
  RunWorkflowOptions,
} from "../../../runtime/run-workflow/run-workflow.types.js";
import { readBranchRunState } from "../../artifacts/run-storage.js";
import { withStepContext } from "../../run-context/with-step-context.js";
import { replayCompletedSteps } from "../replay-completed-steps/replay-completed-steps.js";
import {
  branchScopedReplayEvents,
  findLatestPendingWait,
  findStepStartedIndex,
  readStepIndex,
  readWaitArtifactPaths,
  readWaitId,
  resumeFailure,
  stepDirForIndex,
  stepStartedOrdinalBefore,
} from "./replay-wait-events.js";
import { replayWaitingStepPrefix } from "./replay-waiting-step-prefix.js";
import { resolveBranchNode } from "./resolve-branch-node.js";

export interface ReplayToWaitingStepResult {
  readonly status: "success";
  readonly input: PlainObject;
  readonly node: StepNode;
  readonly resumedStepId: string;
  readonly sourceWaitEventId: string;
  readonly stepIndex: number;
  readonly phaseIndex: number;
  readonly phaseValue: PlainObject;
  readonly waitOutputs: Readonly<Record<string, PlainObject>>;
  readonly seenWaitIds: readonly string[];
  readonly branchId?: string;
  readonly wait: {
    readonly waitId: string;
    readonly kind: "input" | "check";
    readonly message: string;
    readonly artifactPaths: { readonly requestFile: string; readonly answerFile: string };
    readonly outputSchema: Record<string, unknown>;
  };
}

export async function replayToWaitingStep<
  TInput extends PlainObject,
  TOutput extends PlainObject,
>(options: {
  readonly workflow: RunWorkflowOptions<TInput, TOutput>["workflow"];
  readonly events: readonly Event[];
  readonly runDir: string;
  /**
   * Optional parallel-track scope: branch id to resume within. When given,
   * the pending wait must belong to this branch and the branch's persisted
   * run state is read from `runDir/branches/<branchId>.state.json`.
   */
  readonly branchId?: string;
  /**
   * Optional parallel-track scope: explicit step artifact index for the
   * waiting step; overrides the index derived from the wait's artifact paths
   * or step.started history.
   */
  readonly stepIndex?: number;
}): Promise<ReplayToWaitingStepResult | { readonly status: "failure"; readonly failure: Failure }> {
  const startedEvent = options.events.find((event) => event.type === "workflow.started");
  if (!startedEvent) {
    return {
      status: "failure",
      failure: resumeFailure(
        "continue_target_not_found",
        "Continue target has no workflow.started event.",
      ),
    };
  }

  if (startedEvent.workflowId !== options.workflow.id) {
    return {
      status: "failure",
      failure: resumeFailure(
        "continue_workflow_mismatch",
        `Continue target workflow ${startedEvent.workflowId} does not match ${options.workflow.id}.`,
      ),
    };
  }

  if (options.events.some((event) => event.type === "workflow.completed")) {
    return {
      status: "failure",
      failure: resumeFailure(
        "continue_target_not_waiting",
        "Continue target is already completed.",
      ),
    };
  }

  const scopeBranchId = options.branchId;
  if (scopeBranchId !== undefined) {
    try {
      await readBranchRunState(options.runDir, scopeBranchId);
    } catch (error) {
      return {
        status: "failure",
        failure: resumeFailure(
          "continue_target_not_found",
          `Branch ${scopeBranchId} run state is missing or unreadable: ${errorMessage(error)}`,
        ),
      };
    }
  }

  const pendingWait = findLatestPendingWait(options.events, scopeBranchId);
  if (!pendingWait?.stepId) {
    return {
      status: "failure",
      failure: resumeFailure("continue_target_not_waiting", "Continue target has no pending wait."),
    };
  }

  const input = readPlainPayload(startedEvent, "input");
  if (!input) {
    return {
      status: "failure",
      failure: resumeFailure(
        "continue_target_not_found",
        "workflow.started payload is missing input.",
      ),
    };
  }

  const waitId = readWaitId(pendingWait);
  if (!waitId) {
    return {
      status: "failure",
      failure: resumeFailure("continue_wait_invalid", "Pending wait event has no wait id."),
    };
  }

  const stepIndex =
    options.stepIndex ??
    readStepIndex(pendingWait) ??
    stepStartedOrdinalBefore(options.events, pendingWait);
  if (stepIndex === undefined) {
    return {
      status: "failure",
      failure: resumeFailure(
        "continue_wait_invalid",
        `Pending wait ${waitId} has no resolvable step artifact index.`,
      ),
    };
  }

  const targetStepStartedIndex = findStepStartedIndex(options.events, pendingWait, stepIndex);
  if (targetStepStartedIndex === undefined) {
    return {
      status: "failure",
      failure: resumeFailure(
        "continue_wait_invalid",
        `Pending wait ${waitId} has no matching step.started event.`,
      ),
    };
  }

  const resolvedBranchNode =
    scopeBranchId === undefined
      ? undefined
      : resolveBranchNode({
          workflow: options.workflow,
          input,
          branchId: scopeBranchId,
        });
  const replaySourceEvents = options.events.slice(0, targetStepStartedIndex);
  const replay = await replayCompletedSteps({
    workflow: options.workflow,
    events:
      scopeBranchId === undefined
        ? replaySourceEvents
        : branchScopedReplayEvents(replaySourceEvents, scopeBranchId),
    input,
    targetStepId: pendingWait.stepId,
    runDir: options.runDir,
    ...(resolvedBranchNode === undefined ? {} : { startNode: resolvedBranchNode }),
  });
  if (replay.status === "failure") {
    return replay;
  }

  const prefix = await withStepContext(
    pendingWait.stepId,
    stepDirForIndex(options.runDir, pendingWait, stepIndex),
    async () =>
      replayWaitingStepPrefix({
        node: replay.node,
        events: options.events,
        targetStepStartedIndex,
        pendingWait,
        branchId: scopeBranchId,
      }),
  );
  if (prefix.status === "failure") {
    return prefix;
  }

  const wait = await readResumedWaitDetails(options.runDir, pendingWait, waitId);
  if (wait.status === "failure") {
    return wait;
  }

  return {
    status: "success",
    input,
    node: replay.node,
    resumedStepId: pendingWait.stepId,
    sourceWaitEventId: pendingWait.id,
    stepIndex,
    phaseIndex: prefix.phaseIndex,
    phaseValue: prefix.phaseValue,
    waitOutputs: prefix.waitOutputs,
    seenWaitIds: prefix.seenWaitIds,
    ...(scopeBranchId === undefined ? {} : { branchId: scopeBranchId }),
    wait: wait.wait,
  };
}

async function readResumedWaitDetails(
  runDir: string,
  waitEvent: Event,
  waitId: string,
): Promise<
  | {
      readonly status: "success";
      readonly wait: {
        readonly waitId: string;
        readonly kind: "input" | "check";
        readonly message: string;
        readonly artifactPaths: { readonly requestFile: string; readonly answerFile: string };
        readonly outputSchema: Record<string, unknown>;
      };
    }
  | { readonly status: "failure"; readonly failure: Failure }
> {
  const artifactPaths = readWaitArtifactPaths(waitEvent);
  if (!artifactPaths) {
    return {
      status: "failure",
      failure: resumeFailure(
        "continue_wait_invalid",
        `Pending wait ${waitId} has no recorded artifact paths.`,
      ),
    };
  }

  let request: unknown;
  try {
    request = JSON.parse(
      await readFile(join(runDir, ...artifactPaths.requestFile.split("/")), "utf8"),
    );
  } catch {
    return {
      status: "failure",
      failure: resumeFailure(
        "continue_wait_invalid",
        `Pending wait ${waitId} has no readable wait request artifact.`,
      ),
    };
  }

  if (!isPlainObject(request) || !isPlainObject(request.outputSchema)) {
    return {
      status: "failure",
      failure: resumeFailure(
        "continue_wait_invalid",
        `Pending wait ${waitId} request artifact is missing outputSchema.`,
      ),
    };
  }

  const kind = request.kind === "check" ? "check" : "input";
  const message = typeof waitEvent.payload.message === "string" ? waitEvent.payload.message : "";
  return {
    status: "success",
    wait: {
      waitId,
      kind,
      message,
      artifactPaths,
      outputSchema: request.outputSchema,
    },
  };
}
