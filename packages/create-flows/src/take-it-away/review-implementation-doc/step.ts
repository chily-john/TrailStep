import type { StepNode } from "@stepkit/core";
import { type Document, fail, state, step } from "@stepkit/sdk";
import { createOrImproveImplementationDocStep } from "../create-or-improve-implementation-doc/step.js";
import { MAX_IMPLEMENTATION_DOC_REVIEW_ATTEMPTS } from "../shared/constants.js";
import { type ReviewResult, reviewOutput, reviewPasses } from "../shared/review-schema.js";
import { splitImplementationStoriesStep } from "../split-implementation-stories/step.js";
import { type ReviewImplementationDocInput, reviewImplementationDocPrompt } from "./prompt.js";

export async function reviewImplementationDocStep(): Promise<StepNode> {
  const featureDoc = await state.get<Document>("featureDoc");
  const implementationDoc = await state.get<Document>("implementationDoc");
  if (!featureDoc || !implementationDoc) {
    throw new Error("review-implementation-doc: featureDoc/implementationDoc missing from state.");
  }
  const attempt = (await state.get<number>("implementationDocReviewAttempts")) ?? 1;

  const promptInput: ReviewImplementationDocInput = { featureDoc, implementationDoc };

  return step({ id: "review-implementation-doc" })
    .prompt<ReviewImplementationDocInput, ReviewResult>(reviewImplementationDocPrompt, {
      agent: "reviewer",
      output: reviewOutput,
    })
    .do(async (review) => {
      if (reviewPasses(review)) {
        return splitImplementationStoriesStep();
      }

      if (attempt >= MAX_IMPLEMENTATION_DOC_REVIEW_ATTEMPTS) {
        return fail({
          code: "implementation_doc_review_exhausted",
          message: `implementation-doc.md failed review ${MAX_IMPLEMENTATION_DOC_REVIEW_ATTEMPTS} times in a row (last score ${review.score}/5).`,
          details: { review, implementationDocPath: implementationDoc.path },
        });
      }

      await state.set("implementationDocReview", review);
      await state.set("implementationDocReviewAttempts", attempt + 1);
      return createOrImproveImplementationDocStep();
    })(promptInput);
}
