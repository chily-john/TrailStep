import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { jsonSchema, normalizeShape } from "../../../authoring/shape/json-schema.js";
import type { WaitPhase } from "../../../authoring/step/continuation.types.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import { isPlainObject } from "../../../json/guards.js";
import { resolveWaitArtifactPaths } from "../../artifacts/step-artifacts.js";
import { createEvent } from "../../events/create-run-event.js";
import { stepExecutionFailure } from "../../failures/step-execution-failure.js";
import type { Event } from "../../run-workflow/run-workflow.types.js";
import { handleCheckWaitPhase } from "./check-wait-phase.js";
import type { ResumedWaitDetails, WaitingWait } from "./run-continuation.types.js";
import { readTextIfExists } from "./wait-artifacts.js";
import { resolveWaitDefinition, validateWaitDefinition } from "./wait-validation.js";

export type HandleWaitResult =
  | { readonly status: "satisfied"; readonly waitId: string; readonly output: PlainObject }
  | { readonly status: "waiting"; readonly wait: WaitingWait };

export async function handleWaitPhase(options: {
  readonly phase: WaitPhase;
  readonly input: PlainObject;
  readonly output: PlainObject;
  readonly waits: Readonly<Record<string, PlainObject>>;
  readonly phaseIndex: number;
  readonly previousWaitId?: string;
  readonly stepId: string;
  readonly stepArtifactId: string;
  readonly runDir: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly emit: (event: Event) => Promise<void>;
}): Promise<HandleWaitResult> {
  if (options.phase.options !== undefined) {
    return await handleCheckWaitPhase({
      ...options,
      phase: options.phase as WaitPhase & { readonly options: NonNullable<WaitPhase["options"]> },
    });
  }

  const wait = await resolveWaitDefinition(options.phase, {
    input: options.input,
    output: options.output,
    waits: options.waits,
  });
  validateWaitDefinition(wait, options.stepId, options.phaseIndex);

  // A retry attempt must not re-record a wait that an earlier attempt already
  // satisfied: duplicate wait.satisfied events would poison later replays.
  const alreadySatisfiedOutput = options.waits[wait.id];
  if (alreadySatisfiedOutput !== undefined) {
    return { status: "satisfied", waitId: wait.id, output: alreadySatisfiedOutput };
  }

  const artifactPaths = resolveWaitArtifactPaths({
    runDir: options.runDir,
    stepArtifactId: options.stepArtifactId,
    waitId: wait.id,
  });
  const request = {
    stepId: options.stepId,
    waitId: wait.id,
    kind: wait.kind,
    message: wait.message,
    phaseIndex: options.phaseIndex,
    outputSchema: normalizeShape(wait.output).jsonSchema,
  };

  await mkdir(artifactPaths.waitDir, { recursive: true });
  await writeFile(artifactPaths.requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");

  const answerText = await readTextIfExists(artifactPaths.answerFile);
  if (answerText.status === "missing") {
    const waiting = {
      stepId: options.stepId,
      waitId: wait.id,
      message: wait.message,
      artifactPaths: artifactPaths.runRelative,
    };
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.stepId,
        type: "wait.started",
        payload: {
          waitId: wait.id,
          kind: wait.kind,
          message: wait.message,
          phaseIndex: options.phaseIndex,
          artifactPaths: artifactPaths.runRelative,
        },
      }),
    );
    return { status: "waiting", wait: waiting };
  }

  try {
    const parsedAnswer: unknown = JSON.parse(answerText.value);
    if (!isPlainObject(parsedAnswer)) {
      throw new TypeError(`step ${options.stepId} wait ${wait.id} answer must be a plain object`);
    }
    const output = normalizeShape(wait.output).assert(
      parsedAnswer,
      `step ${options.stepId} wait ${wait.id} answer`,
    );
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.stepId,
        type: "wait.satisfied",
        payload: {
          waitId: wait.id,
          kind: wait.kind,
          message: wait.message,
          phaseIndex: options.phaseIndex,
          artifactPaths: artifactPaths.runRelative,
          output,
        },
      }),
    );
    return { status: "satisfied", waitId: wait.id, output };
  } catch (error) {
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.stepId,
        type: "wait.failed",
        payload: {
          waitId: wait.id,
          kind: wait.kind,
          message: wait.message,
          phaseIndex: options.phaseIndex,
          artifactPaths: artifactPaths.runRelative,
          failure: stepExecutionFailure(error),
        },
      }),
    );
    throw error;
  }
}

export async function handleResumedWaitPhase(options: {
  readonly wait: ResumedWaitDetails;
  readonly stepId: string;
  readonly runDir: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly emit: (event: Event) => Promise<void>;
}): Promise<HandleWaitResult> {
  const answerFile = joinRunPath(options.runDir, options.wait.artifactPaths.answerFile);
  const answerText = await readTextIfExists(answerFile);
  if (answerText.status === "missing") {
    return {
      status: "waiting",
      wait: {
        stepId: options.stepId,
        waitId: options.wait.waitId,
        message: options.wait.message,
        artifactPaths: options.wait.artifactPaths,
      },
    };
  }

  try {
    const parsedAnswer: unknown = JSON.parse(answerText.value);
    if (!isPlainObject(parsedAnswer)) {
      throw new TypeError(
        `step ${options.stepId} wait ${options.wait.waitId} answer must be a plain object`,
      );
    }
    const output = jsonSchema<PlainObject>(options.wait.outputSchema).assert(
      parsedAnswer,
      `step ${options.stepId} wait ${options.wait.waitId} answer`,
    );
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.stepId,
        type: "wait.satisfied",
        payload: {
          waitId: options.wait.waitId,
          kind: options.wait.kind,
          message: options.wait.message,
          artifactPaths: options.wait.artifactPaths,
          output,
        },
      }),
    );
    return { status: "satisfied", waitId: options.wait.waitId, output };
  } catch (error) {
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.stepId,
        type: "wait.failed",
        payload: {
          waitId: options.wait.waitId,
          kind: options.wait.kind,
          message: options.wait.message,
          artifactPaths: options.wait.artifactPaths,
          failure: stepExecutionFailure(error),
        },
      }),
    );
    throw error;
  }
}

function joinRunPath(runDir: string, runRelativePath: string): string {
  return join(runDir, ...runRelativePath.split("/"));
}
