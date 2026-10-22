import type {
  ContinuationResult,
  DisplayPhase,
  PromptPhase,
  StepNode,
  WaitPhase,
} from "../../../authoring/step/continuation.types.js";
import { getStepPhases } from "../../../authoring/step/step-node.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import { isPlainObject } from "../../../json/guards.js";
import {
  type CancellationMarker,
  throwIfCancellationRequested,
} from "../../cancellation/cancellation.js";
import type { ResumedWaitDetails, WaitingWait } from "./run-continuation.types.js";
import { throwIfStepTimedOut } from "./step-control.js";
import type { HandleWaitResult } from "./wait-phase.js";

export type RunStepPhasesResult =
  | { readonly status: "continued"; readonly node: ContinuationResult }
  | { readonly status: "waiting"; readonly wait: WaitingWait };

export async function runStepPhases(options: {
  readonly stepNode: StepNode;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly readCancellation: () => Promise<CancellationMarker | undefined>;
  /** Satisfied wait outputs shared across retry attempts of the same step. */
  readonly sharedWaitOutputs?: Record<string, PlainObject>;
  readonly emitDisplay: (
    phase: DisplayPhase,
    output: PlainObject,
    phaseIndex: number,
  ) => Promise<void>;
  readonly handleWait: (
    phase: WaitPhase,
    output: PlainObject,
    phaseIndex: number,
    waits: Readonly<Record<string, PlainObject>>,
    previousWaitId?: string,
  ) => Promise<HandleWaitResult>;
  readonly handleResumedWait: (wait: ResumedWaitDetails) => Promise<HandleWaitResult>;
  readonly dispatchPrompt: (phase: PromptPhase) => Promise<PlainObject>;
  readonly resume?: {
    readonly startPhaseIndex: number;
    readonly phaseValue: PlainObject;
    readonly waitOutputs: Readonly<Record<string, PlainObject>>;
    readonly seenWaitIds: readonly string[];
    readonly wait: ResumedWaitDetails;
  };
}): Promise<RunStepPhasesResult> {
  const { stepNode } = options;
  let phaseValue = options.resume?.phaseValue ?? stepNode.config.input;
  let nextNode: ContinuationResult | undefined;
  const waitOutputs: Record<string, PlainObject> = options.sharedWaitOutputs ?? {
    ...(options.resume?.waitOutputs ?? {}),
  };
  const seenWaitIds = new Set<string>(options.resume?.seenWaitIds ?? []);
  const phases = getStepPhases(stepNode);
  assertNoDuplicateStaticWaitIds(phases, stepNode.config.id);

  for (const [phaseIndex, phase] of phases.entries()) {
    if (phaseIndex < (options.resume?.startPhaseIndex ?? 0)) {
      continue;
    }
    throwIfCancellationRequested(await options.readCancellation());

    if (phase.kind === "display") {
      await options.emitDisplay(phase, phaseValue, phaseIndex);
      throwIfCancellationRequested(await options.readCancellation());
      throwIfStepTimedOut(options.signal, stepNode.config.id, options.timeoutMs);
      continue;
    }

    if (phase.kind === "wait") {
      const waitResult =
        options.resume !== undefined && phaseIndex === options.resume.startPhaseIndex
          ? options.resume.wait.kind === "check"
            ? await options.handleWait(
                phase,
                phaseValue,
                phaseIndex,
                waitOutputs,
                options.resume.wait.waitId,
              )
            : await options.handleResumedWait(options.resume.wait)
          : await options.handleWait(phase, phaseValue, phaseIndex, waitOutputs);
      const waitId = waitResult.status === "waiting" ? waitResult.wait.waitId : waitResult.waitId;
      if (seenWaitIds.has(waitId)) {
        throw new Error(`step ${stepNode.config.id} has duplicate wait id '${waitId}'`);
      }
      seenWaitIds.add(waitId);

      if (waitResult.status === "waiting") {
        throwIfCancellationRequested(await options.readCancellation());
        return waitResult;
      }

      waitOutputs[waitResult.waitId] = waitResult.output;
      throwIfCancellationRequested(await options.readCancellation());
      throwIfStepTimedOut(options.signal, stepNode.config.id, options.timeoutMs);
      continue;
    }

    if (nextNode !== undefined) {
      throw new Error(`step ${stepNode.config.id} has executable phases after a do phase`);
    }

    if (phase.kind === "prompt") {
      phaseValue = await options.dispatchPrompt(phase);
      throwIfCancellationRequested(await options.readCancellation());
      throwIfStepTimedOut(options.signal, stepNode.config.id, options.timeoutMs);
      continue;
    }

    nextNode = await phase.onOutput(
      withWaitsDoContext(phaseValue, waitOutputs),
      stepNode.config.input,
    );
    throwIfCancellationRequested(await options.readCancellation());
    throwIfStepTimedOut(options.signal, stepNode.config.id, options.timeoutMs);
  }

  if (nextNode === undefined) {
    throw new Error(`step ${stepNode.config.id} has no do phase`);
  }

  return { status: "continued", node: nextNode };
}

function assertNoDuplicateStaticWaitIds(phases: readonly unknown[], stepId: string): void {
  const seenWaitIds = new Set<string>();
  for (const phase of phases) {
    if (!isPlainObject(phase) || phase.kind !== "wait") {
      continue;
    }
    const wait = phase.wait;
    if (typeof wait === "function" || !isPlainObject(wait) || typeof wait.id !== "string") {
      continue;
    }
    if (seenWaitIds.has(wait.id)) {
      throw new Error(`step ${stepId} has duplicate wait id '${wait.id}'`);
    }
    seenWaitIds.add(wait.id);
  }
}

function withWaitsDoContext(
  output: PlainObject,
  waits: Readonly<Record<string, PlainObject>>,
): PlainObject {
  return new Proxy(output, {
    get(target, property, receiver) {
      if (property === "output") {
        return target;
      }
      if (property === "waits") {
        return waits;
      }
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return property === "output" || property === "waits" || Reflect.has(target, property);
    },
    getOwnPropertyDescriptor(target, property) {
      if (property === "output") {
        return { configurable: true, enumerable: false, value: target };
      }
      if (property === "waits") {
        return { configurable: true, enumerable: false, value: waits };
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
}
