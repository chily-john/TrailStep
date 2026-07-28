import { fail, step } from "@stepkit/sdk";
import { createOrImproveImplementationDocStep } from "../create-or-improve-implementation-doc/step.js";
import { MAX_IMPLEMENTATION_DOC_REVIEW_ATTEMPTS } from "../shared/constants.js";
import type { ReviewResult } from "../shared/review-schema.js";
import { reviewOutput, reviewPasses } from "../shared/review-schema.js";
import { splitImplementationStoriesStep } from "../split-implementation-stories/step.js";
import { type ReviewImplementationDocInput, reviewImplementationDocPrompt } from "./prompt.js";

export const reviewImplementationDocStep = step({ id: "review-implementation-doc" })
  .prompt<ReviewImplementationDocInput, ReviewResult>(reviewImplementationDocPrompt, {
    agent: "reviewer",
    output: reviewOutput,
  })
  .do((review, input) => {
    if (reviewPasses(review)) {
      return splitImplementationStoriesStep({ implementationDoc: input.implementationDoc });
    }

    if (input.attempt >= MAX_IMPLEMENTATION_DOC_REVIEW_ATTEMPTS) {
      return fail({
        code: "implementation_doc_review_exhausted",
        message: `implementation-doc.md failed review ${MAX_IMPLEMENTATION_DOC_REVIEW_ATTEMPTS} times in a row (last score ${review.score}/5).`,
        details: { review, implementationDocPath: input.implementationDoc.path },
      });
    }

    return createOrImproveImplementationDocStep({
      featureDoc: input.featureDoc,
      previousReview: review,
      attempt: input.attempt + 1,
    });
  });
