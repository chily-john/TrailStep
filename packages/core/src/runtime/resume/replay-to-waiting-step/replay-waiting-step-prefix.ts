import type { StepNode, WaitPhase } from "../../../authoring/step/continuation.types.js";
import { getStepPhases } from "../../../authoring/step/step-node.js";
import type { Failure } from "../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import { isPlainObject } from "../../../json/guards.js";
import type { Event } from "../../../runtime/run-workflow/run-workflow.types.js";
import { resolveStepOutputSchema } from "../../continuation/resolve-step-output-schema/resolve-step-output-schema.js";
import { readWaitId, resumeFailure } from "./replay-wait-events.js";

/**
 * Replays the phases of the waiting step that come before the pending wait, so
 * the resumed run continues with the same phase value and wait outputs the
 * original run had.
 */
export async function replayWaitingStepPrefix(options: {
  readonly node: StepNode;
  readonly events: readonly Event[];
  readonly targetStepStartedIndex: number;
  readonly pendingWait: Event;
  readonly branchId?: string;
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
  const belongsToScopedBranch = (event: Event): boolean =>
    options.branchId === undefined ||
    event.payload.branchId === undefined ||
    event.payload.branchId === options.branchId;
  const promptOutputs = inStepEvents.filter(
    (event) =>
      event.type === "step.completed" &&
      event.stepId === options.node.config.id &&
      belongsToScopedBranch(event) &&
      isPlainObject(event.payload.output),
  );
  const satisfiedWaits = inStepEvents.filter(
    (event) =>
      event.type === "wait.satisfied" &&
      event.stepId === options.node.config.id &&
      belongsToScopedBranch(event) &&
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

  if (phase.options !== undefined) {
    return false;
  }

  const wait =
    typeof phase.wait === "function"
      ? await (
          phase.wait as (waitContext: {
            readonly input: PlainObject;
            readonly output: PlainObject;
            readonly waits: Readonly<Record<string, PlainObject>>;
          }) => unknown | Promise<unknown>
        )({
          input: context.input,
          output: context.phaseValue,
          waits: context.waitOutputs,
        })
      : phase.wait;
  return isPlainObject(wait) && wait.id === context.waitId;
}
