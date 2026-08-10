import { Document, state, step } from "@trailstep/authoring";
import { createOrImproveImplementationDocStep } from "../create-or-improve-implementation-doc/step.js";
import { createFeatureDocPrompt } from "./prompt.js";

export const createFeatureDocStep = step({ id: "create-feature-doc" })
  .prompt(createFeatureDocPrompt, {
    agent: "featureWriter",
    output: Document,
  })
  .do(async (featureDoc) => {
    await state.set("featureDoc", featureDoc);
    return createOrImproveImplementationDocStep({ featureDoc, attempt: 1 });
  });
