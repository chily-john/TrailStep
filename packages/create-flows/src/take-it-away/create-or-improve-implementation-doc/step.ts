import type { Document } from "@stepkit/sdk";
import { documentOutput, state, step } from "@stepkit/sdk";
import { reviewImplementationDocStep } from "../review-implementation-doc/step.js";
import {
  type CreateOrImproveImplementationDocInput,
  createOrImproveImplementationDocPrompt,
} from "./prompt.js";

export const createOrImproveImplementationDocStep = step({
  id: "create-or-improve-implementation-doc",
})
  .prompt<CreateOrImproveImplementationDocInput, Document>(createOrImproveImplementationDocPrompt, {
    agent: "planner",
    output: documentOutput,
  })
  .do(async (implementationDoc, input) => {
    await state.set("implementationDoc", implementationDoc);
    return reviewImplementationDocStep({
      featureDoc: input.featureDoc,
      implementationDoc,
      attempt: input.attempt,
    });
  });
