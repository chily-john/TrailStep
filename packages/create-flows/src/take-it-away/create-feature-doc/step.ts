import type { StepNode } from "@stepkit/core";
import { type Document, documentOutput, state, step } from "@stepkit/sdk";
import { createOrImproveImplementationDocStep } from "../create-or-improve-implementation-doc/step.js";
import type { TakeItAwayInput } from "../shared/input-schema.js";
import { createFeatureDocPrompt } from "./prompt.js";

/**
 * The only step invoked directly by `defineWorkflow`'s sync `start(...)`
 * rather than from a previous step's continuation — it's how the workflow's
 * own input enters the run. Every step after this one receives its input as
 * an explicit argument from whichever step's `.do(...)` continuation returns it.
 */
export function createFeatureDocStep(input: TakeItAwayInput): StepNode {
  return step({ id: "create-feature-doc" })
    .prompt<TakeItAwayInput, Document>(createFeatureDocPrompt, {
      agent: "featureWriter",
      output: documentOutput,
    })
    .do(async (featureDoc) => {
      await state.set("featureDoc", featureDoc);
      return createOrImproveImplementationDocStep({ featureDoc, attempt: 1 });
    })(input);
}
