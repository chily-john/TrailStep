import { Document, state, step } from "@trailstep/authoring";
import { createOrImproveImplementationStrategyStep } from "../create-or-improve-implementation-strategy/step.js";
import { createFeatureDocPrompt } from "./prompt.js";

export const createFeatureDocStep = step({ id: "create-feature-doc" })
  .prompt(createFeatureDocPrompt, {
    agent: "featureWriter",
    output: Document,
  })
  .do(async (featureDoc) => {
    await state.set("featureDoc", featureDoc);
    return createOrImproveImplementationStrategyStep({ featureDoc, attempt: 1 });
  });
