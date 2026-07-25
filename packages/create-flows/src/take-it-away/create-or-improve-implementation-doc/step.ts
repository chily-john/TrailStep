import type { StepNode } from "@stepkit/core";
import { type Document, documentOutput, state, step } from "@stepkit/sdk";
import { reviewImplementationDocStep } from "../review-implementation-doc/step.js";
import type { ReviewResult } from "../shared/review-schema.js";
import {
  type CreateOrImproveImplementationDocInput,
  createOrImproveImplementationDocPrompt,
} from "./prompt.js";

export async function createOrImproveImplementationDocStep(): Promise<StepNode> {
  const featureDoc = await state.get<Document>("featureDoc");
  if (!featureDoc) {
    throw new Error("create-or-improve-implementation-doc: featureDoc missing from state.");
  }
  const previousReview = await state.get<ReviewResult>("implementationDocReview");
  const attempt = (await state.get<number>("implementationDocReviewAttempts")) ?? 1;

  const promptInput: CreateOrImproveImplementationDocInput = {
    featureDoc,
    previousReview,
    attempt,
  };

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
      return reviewImplementationDocStep();
    })(promptInput);
}
