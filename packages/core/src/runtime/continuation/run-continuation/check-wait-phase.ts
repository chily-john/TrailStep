import { mkdir, writeFile } from "node:fs/promises";
import { normalizeShape } from "../../../authoring/shape/json-schema.js";
import type {
  CheckWaitHelpers,
  WaitCheckResult,
  WaitPhase,
} from "../../../authoring/step/continuation.types.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import { resolveWaitArtifactPaths } from "../../artifacts/step-artifacts.js";
import { createEvent } from "../../events/create-run-event.js";
import { stepExecutionFailure } from "../../failures/step-execution-failure.js";
import type { Event } from "../../run-workflow/run-workflow.types.js";
import type { HandleWaitResult } from "./wait-phase.js";
import {
  createCheckWaitHelpers,
  validateCheckWaitResult,
  validatePendingWait,
} from "./wait-validation.js";

export async function handleCheckWaitPhase(options: {
  readonly phase: WaitPhase & { readonly options: NonNullable<WaitPhase["options"]> };
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
  const outputSchema = normalizeShape(options.phase.options.output);
  const defaultWaitId = options.previousWaitId ?? `check-${options.phaseIndex}`;
  let waitId = defaultWaitId;

  const alreadySatisfiedCheckOutput = options.waits[waitId];
  if (alreadySatisfiedCheckOutput !== undefined) {
    return { status: "satisfied", waitId, output: alreadySatisfiedCheckOutput };
  }

  try {
    if (typeof options.phase.wait !== "function") {
      throw new TypeError(
        `step ${options.stepId} check wait phase ${options.phaseIndex} requires a callback.`,
      );
    }

    const check = options.phase.wait as (context: {
      readonly input: PlainObject;
      readonly output: PlainObject;
      readonly waits: Readonly<Record<string, PlainObject>>;
      readonly wait: CheckWaitHelpers<PlainObject>;
    }) => WaitCheckResult | Promise<WaitCheckResult>;
    const result = await check({
      input: options.input,
      output: options.output,
      waits: options.waits,
      wait: createCheckWaitHelpers(),
    });
    validateCheckWaitResult(result, options.stepId, options.phaseIndex);

    if (result.status === "pending") {
      validatePendingWait(result, options.stepId, options.phaseIndex);
      waitId = result.id;
      const satisfiedPendingOutput = options.waits[waitId];
      if (satisfiedPendingOutput !== undefined) {
        return { status: "satisfied", waitId, output: satisfiedPendingOutput };
      }
      const artifactPaths = resolveWaitArtifactPaths({
        runDir: options.runDir,
        stepArtifactId: options.stepArtifactId,
        waitId,
      });
      const request = {
        stepId: options.stepId,
        waitId,
        kind: "check",
        message: result.message,
        phaseIndex: options.phaseIndex,
        ...(result.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: result.retryAfterSeconds }),
        outputSchema: outputSchema.jsonSchema,
      };

      await mkdir(artifactPaths.waitDir, { recursive: true });
      await writeFile(artifactPaths.requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");

      await options.emit(
        createEvent({
          runId: options.runId,
          workflowId: options.workflowId,
          stepId: options.stepId,
          type: "wait.started",
          payload: {
            waitId,
            kind: "check",
            message: result.message,
            phaseIndex: options.phaseIndex,
            ...(result.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: result.retryAfterSeconds }),
            artifactPaths: artifactPaths.runRelative,
          },
        }),
      );

      return {
        status: "waiting",
        wait: {
          stepId: options.stepId,
          waitId,
          kind: "check",
          message: result.message,
          ...(result.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: result.retryAfterSeconds }),
          artifactPaths: artifactPaths.runRelative,
        },
      };
    }

    const output = outputSchema.assert(
      result.output,
      `step ${options.stepId} check wait ${waitId} output`,
    );
    const artifactPaths = resolveWaitArtifactPaths({
      runDir: options.runDir,
      stepArtifactId: options.stepArtifactId,
      waitId,
    });
    await mkdir(artifactPaths.waitDir, { recursive: true });
    await writeFile(
      artifactPaths.requestFile,
      `${JSON.stringify(
        {
          stepId: options.stepId,
          waitId,
          kind: "check",
          phaseIndex: options.phaseIndex,
          outputSchema: outputSchema.jsonSchema,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.stepId,
        type: "wait.satisfied",
        payload: {
          waitId,
          kind: "check",
          phaseIndex: options.phaseIndex,
          artifactPaths: artifactPaths.runRelative,
          output,
        },
      }),
    );
    return { status: "satisfied", waitId, output };
  } catch (error) {
    await options.emit(
      createEvent({
        runId: options.runId,
        workflowId: options.workflowId,
        stepId: options.stepId,
        type: "wait.failed",
        payload: {
          waitId,
          kind: "check",
          phaseIndex: options.phaseIndex,
          failure: stepExecutionFailure(error),
        },
      }),
    );
    throw error;
  }
}
