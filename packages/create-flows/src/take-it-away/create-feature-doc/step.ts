import type { StepNode } from "@stepkit/core";
import { type Document, documentOutput, state, step } from "@stepkit/sdk";
import { createOrImproveImplementationDocStep } from "../create-or-improve-implementation-doc/step.js";
import type { TakeItAwayInput } from "../shared/input-schema.js";
import { createFeatureDocPrompt } from "./prompt.js";

/**
 * The only step whose input can't come from `state` — it's how the
 * workflow's own input (from `defineWorkflow`'s sync `start`) enters the run.
 * Every step after this one pulls what it needs from `state` instead.
 */
export function createFeatureDocStep(input: TakeItAwayInput): StepNode {
  return step({ id: "create-feature-doc" })
    .prompt<TakeItAwayInput, Document>(createFeatureDocPrompt, {
      agent: "featureWriter",
      output: documentOutput,
    })
    .do(async (featureDoc) => {
      await state.set("featureDoc", featureDoc);
      await state.set("implementationDocReviewAttempts", 1);
      return createOrImproveImplementationDocStep();
    })(input);
}
