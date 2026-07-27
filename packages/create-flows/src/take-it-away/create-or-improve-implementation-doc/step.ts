import type { StepNode } from "@stepkit/core";
import { type Document, documentOutput, state, step } from "@stepkit/sdk";
import { reviewImplementationDocStep } from "../review-implementation-doc/step.js";
import {
  type CreateOrImproveImplementationDocInput,
  createOrImproveImplementationDocPrompt,
} from "./prompt.js";

export function createOrImproveImplementationDocStep(
  input: CreateOrImproveImplementationDocInput,
): StepNode {
  return step({ id: "create-or-improve-implementation-doc" })
    .prompt<CreateOrImproveImplementationDocInput, Document>(
      createOrImproveImplementationDocPrompt,
      {
        agent: "planner",
        output: documentOutput,
      },
    )
    .do(async (implementationDoc) => {
      await state.set("implementationDoc", implementationDoc);
      return reviewImplementationDocStep({
        featureDoc: input.featureDoc,
        implementationDoc,
        attempt: input.attempt,
      });
    })(input);
}
