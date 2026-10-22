import type { normalizeShape } from "../../../authoring/shape/json-schema.js";
import type { ContinuationResult } from "../../../authoring/step/continuation.types.js";
import { done } from "../../../authoring/step/step-node.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import { failureFromError } from "./continuation-failures.js";
import type { ContinuationPostHandler, WorkflowInvocationFrame } from "./run-continuation.types.js";

export type SplitPostContinuation = ContinuationPostHandler;

export function splitPostContinuationForInvocationFrames(
  invocationFrames: readonly WorkflowInvocationFrame[],
  currentWorkflowOutputSchema: ReturnType<typeof normalizeShape> | undefined,
  currentWorkflowId: string,
): SplitPostContinuation | undefined {
  if (invocationFrames.length === 0) {
    return undefined;
  }

  const frames = [...invocationFrames];
  const splitWorkflowOutputSchema = currentWorkflowOutputSchema;
  return async (aggregateOutput: PlainObject): Promise<ContinuationResult> => {
    let output: PlainObject;
    try {
      output =
        splitWorkflowOutputSchema === undefined
          ? aggregateOutput
          : splitWorkflowOutputSchema.assert(
              aggregateOutput,
              `invoked workflow ${frames[frames.length - 1]?.invocationWorkflowId ?? currentWorkflowId} output`,
            );
    } catch (error) {
      throw failureFromError(error);
    }

    while (frames.length > 0) {
      const frame = frames.pop();
      if (frame?.postContinuation !== undefined) {
        return await frame.postContinuation(output);
      }
    }

    return done(output);
  };
}

export function splitPostContinuations(
  postContinuation: SplitPostContinuation | undefined,
  invocationPostContinuation: SplitPostContinuation | undefined,
): {
  readonly postContinuation?: SplitPostContinuation;
  readonly afterPostContinuation?: SplitPostContinuation;
} {
  if (postContinuation === undefined) {
    return invocationPostContinuation === undefined
      ? {}
      : { postContinuation: invocationPostContinuation };
  }
  return invocationPostContinuation === undefined
    ? { postContinuation }
    : { postContinuation, afterPostContinuation: invocationPostContinuation };
}
