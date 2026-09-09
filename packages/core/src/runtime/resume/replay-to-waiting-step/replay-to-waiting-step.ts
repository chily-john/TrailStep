import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepNode, WaitPhase } from "../../../authoring/step/continuation.types.js";
import { getStepPhases } from "../../../authoring/step/step-node.js";
import type { Failure } from "../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import type {
  Event,
  RunWorkflowOptions,
} from "../../../runtime/run-workflow/run-workflow.types.js";
import { resolveStepOutputSchema } from "../../continuation/resolve-step-output-schema/resolve-step-output-schema.js";
import { withStepContext } from "../../run-context/with-step-context.js";
import { replayCompletedSteps } from "../replay-completed-steps/replay-completed-steps.js";

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
  readonly wait: {
    readonly waitId: string;
    readonly kind: "input";
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

  const pendingWait = findLatestPendingWait(options.events);
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
    readStepIndex(pendingWait) ?? stepStartedOrdinalBefore(options.events, pendingWait);
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

  const replay = await replayCompletedSteps({
    workflow: options.workflow,
    events: options.events.slice(0, targetStepStartedIndex),
    input,
    targetStepId: pendingWait.stepId,
    runDir: options.runDir,
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
        readonly kind: "input";
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

  const message = typeof waitEvent.payload.message === "string" ? waitEvent.payload.message : "";
  return {
    status: "success",
    wait: {
      waitId,
      kind: "input",
      message,
      artifactPaths,
      outputSchema: request.outputSchema,
    },
  };
}

function findLatestPendingWait(events: readonly Event[]): Event | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "wait.started") {
      continue;
    }

    const key = waitEventKey(event);
    if (!key) {
      continue;
    }

    const resolvedLater = events
      .slice(index + 1)
      .some(
        (laterEvent) =>
          (laterEvent.type === "wait.satisfied" || laterEvent.type === "wait.failed") &&
          waitEventKey(laterEvent) === key,
      );
    if (!resolvedLater) {
      return event;
    }
  }

  return undefined;
}

async function replayWaitingStepPrefix(options: {
  readonly node: StepNode;
  readonly events: readonly Event[];
  readonly targetStepStartedIndex: number;
  readonly pendingWait: Event;
}): Promise<
  | {
      readonly status: "success";
      readonly phaseIndex: number;
      readonly phaseValue: PlainObject;
      readonly waitOutputs: Readonly<Record<string, PlainObject>>;
      readonly seenWaitIds: readonly string[];
    }
  | { readonly status: "failure"; readonly failure: Failure }
> {
  const waitId = readWaitId(options.pendingWait);
  const targetPhaseIndex =
    typeof options.pendingWait.payload.phaseIndex === "number"
      ? options.pendingWait.payload.phaseIndex
      : undefined;
  const pendingWaitIndex = options.events.indexOf(options.pendingWait);
  const inStepEvents = options.events.slice(options.targetStepStartedIndex + 1, pendingWaitIndex);
  const promptOutputs = inStepEvents.filter(
    (event) =>
      event.type === "step.completed" &&
      event.stepId === options.node.config.id &&
      isPlainObject(event.payload.output),
  );
  const satisfiedWaits = inStepEvents.filter(
    (event) =>
      event.type === "wait.satisfied" &&
      event.stepId === options.node.config.id &&
      isPlainObject(event.payload.output) &&
      typeof event.payload.waitId === "string",
  );

  let phaseValue = options.node.config.input;
  let promptOutputIndex = 0;
  let satisfiedWaitIndex = 0;
  const waitOutputs: Record<string, PlainObject> = {};
  const seenWaitIds: string[] = [];

  for (const [phaseIndex, phase] of getStepPhases(options.node).entries()) {
    if (phase.kind === "display") {
      continue;
    }

    if (phase.kind === "prompt") {
      const completedEvent = promptOutputs[promptOutputIndex];
      promptOutputIndex += 1;
      if (!completedEvent || !isPlainObject(completedEvent.payload.output)) {
        return {
          status: "failure",
          failure: resumeFailure(
            "continue_missing_step_output",
            `Step ${options.node.config.id} has no recorded prompt output before wait ${waitId ?? "<missing>"}.`,
          ),
        };
      }

      const outputSchema = resolveStepOutputSchema(phase);
      if (!outputSchema) {
        return {
          status: "failure",
          failure: resumeFailure(
            "continue_output_schema_unresolvable",
            `Step ${options.node.config.id} has no resolvable output schema to continue with.`,
          ),
        };
      }
      phaseValue = outputSchema.assert(
        completedEvent.payload.output,
        `step ${options.node.config.id} output`,
      );
      continue;
    }

    if (phase.kind === "wait") {
      const isTargetPhase =
        targetPhaseIndex === undefined
          ? await waitPhaseMatches(phase, {
              phaseValue,
              waitOutputs,
              input: options.node.config.input,
              waitId,
            })
          : phaseIndex === targetPhaseIndex;
      if (isTargetPhase) {
        return {
          status: "success",
          phaseIndex,
          phaseValue,
          waitOutputs,
          seenWaitIds,
        };
      }

      const satisfiedEvent = satisfiedWaits[satisfiedWaitIndex];
      satisfiedWaitIndex += 1;
      const satisfiedWaitId =
        typeof satisfiedEvent?.payload.waitId === "string"
          ? satisfiedEvent.payload.waitId
          : undefined;
      if (!satisfiedWaitId || !isPlainObject(satisfiedEvent?.payload.output)) {
        return {
          status: "failure",
          failure: resumeFailure(
            "continue_missing_wait_output",
            `Step ${options.node.config.id} has no recorded satisfied wait output before wait ${waitId ?? "<missing>"}.`,
          ),
        };
      }

      if (seenWaitIds.includes(satisfiedWaitId)) {
        return {
          status: "failure",
          failure: resumeFailure(
            "continue_duplicate_wait_id",
            `Step ${options.node.config.id} has duplicate wait id '${satisfiedWaitId}'.`,
          ),
        };
      }
      seenWaitIds.push(satisfiedWaitId);
      waitOutputs[satisfiedWaitId] = satisfiedEvent.payload.output;
      continue;
    }

    return {
      status: "failure",
      failure: resumeFailure(
        "continue_wait_after_do",
        `Pending wait ${waitId ?? "<missing>"} occurs after step ${options.node.config.id}'s do phase.`,
      ),
    };
  }

  return {
    status: "failure",
    failure: resumeFailure(
      "continue_wait_not_reachable",
      `Pending wait ${waitId ?? "<missing>"} was not found in step ${options.node.config.id}.`,
    ),
  };
}

async function waitPhaseMatches(
  phase: WaitPhase,
  context: {
    readonly phaseValue: PlainObject;
    readonly waitOutputs: Readonly<Record<string, PlainObject>>;
    readonly input: PlainObject;
    readonly waitId: string | undefined;
  },
): Promise<boolean> {
  if (!context.waitId) {
    return false;
  }

  const wait =
    typeof phase.wait === "function"
      ? await phase.wait({
          input: context.input,
          output: context.phaseValue,
          waits: context.waitOutputs,
        })
      : phase.wait;
  return isPlainObject(wait) && wait.id === context.waitId;
}

function findStepStartedIndex(
  events: readonly Event[],
  pendingWait: Event,
  stepIndex: number,
): number | undefined {
  let ordinal = 0;
  for (const [index, event] of events.entries()) {
    if (event.type !== "step.started") {
      continue;
    }
    ordinal += 1;
    if (ordinal === stepIndex) {
      return index;
    }
  }

  for (let index = events.indexOf(pendingWait); index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "step.started" && event.stepId === pendingWait.stepId) {
      return index;
    }
  }

  return undefined;
}

function stepStartedOrdinalBefore(
  events: readonly Event[],
  pendingWait: Event,
): number | undefined {
  const waitIndex = events.indexOf(pendingWait);
  if (waitIndex === -1) {
    return undefined;
  }
  const count = events.slice(0, waitIndex).filter((event) => event.type === "step.started").length;
  return count > 0 ? count : undefined;
}

function readStepIndex(event: Event): number | undefined {
  const artifactStepId = readArtifactStepId(event);
  const prefix = artifactStepId?.match(/^(\d+)-/u)?.[1];
  if (prefix === undefined) {
    return undefined;
  }

  const stepIndex = Number(prefix);
  return Number.isInteger(stepIndex) && stepIndex > 0 ? stepIndex : undefined;
}

function stepDirForIndex(runDir: string, event: Event, stepIndex: number): string {
  const artifactStepId =
    readArtifactStepId(event) ?? `${String(stepIndex).padStart(4, "0")}-${event.stepId ?? "step"}`;
  return join(runDir, "steps", artifactStepId);
}

function readArtifactStepId(event: Event): string | undefined {
  const artifactPaths = readWaitArtifactPaths(event);
  const path = artifactPaths?.requestFile ?? artifactPaths?.answerFile;
  return path?.match(/^steps\/([^/]+)\/waits\//u)?.[1];
}

function readWaitArtifactPaths(
  event: Event,
): { readonly requestFile: string; readonly answerFile: string } | undefined {
  const artifactPaths = event.payload.artifactPaths;
  if (!isPlainObject(artifactPaths)) {
    return undefined;
  }

  const requestFile = artifactPaths.requestFile;
  const answerFile = artifactPaths.answerFile;
  if (typeof requestFile !== "string" || typeof answerFile !== "string") {
    return undefined;
  }

  return { requestFile, answerFile };
}

function waitEventKey(event: Event): string | undefined {
  const artifactPaths = event.payload.artifactPaths;
  if (isPlainObject(artifactPaths) && typeof artifactPaths.answerFile === "string") {
    return artifactPaths.answerFile;
  }

  const waitId = readWaitId(event);
  return event.stepId && waitId ? `${event.stepId}:${waitId}` : undefined;
}

function readWaitId(event: Event): string | undefined {
  return typeof event.payload.waitId === "string" ? event.payload.waitId : undefined;
}

function readPlainPayload(event: Event, key: string): PlainObject | undefined {
  const value = event.payload[key];
  return isPlainObject(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function resumeFailure(code: string, message: string): Failure {
  return { code, message };
}
