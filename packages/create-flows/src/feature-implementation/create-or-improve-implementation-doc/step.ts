import { Document, state, step } from "@stepkit/authoring";
import { reviewImplementationDocStep } from "../review-implementation-doc/step.js";
import { createOrImproveImplementationDocPrompt } from "./prompt.js";

export const createOrImproveImplementationDocStep = step({
  id: "create-or-improve-implementation-doc",
})
  .prompt(createOrImproveImplementationDocPrompt, {
    agent: "planner",
    output: Document,
  })
  .do(async (implementationDoc, input) => {
    await state.set("implementationDoc", implementationDoc);
    return reviewImplementationDocStep({
      featureDoc: input.featureDoc,
      implementationDoc,
      attempt: input.attempt,
    });
  });
