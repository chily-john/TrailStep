import { fail, type StepFactory, step } from "@trailstep/authoring";
import { createOrImproveImplementationStrategyStep } from "../create-or-improve-implementation-strategy/step.js";
import { MAX_IMPLEMENTATION_DOC_REVIEW_ATTEMPTS } from "../shared/constants.js";
import type { ReviewResult } from "../shared/review-schema.js";
import { reviewOutput, reviewPasses } from "../shared/review-schema.js";
import { sliceImplementationStoriesStep } from "../slice-implementation-stories/step.js";
import {
  type ReviewImplementationStrategyInput,
  reviewImplementationStrategyPrompt,
} from "./prompt.js";

export const reviewImplementationStrategyStep: StepFactory<
  ReviewImplementationStrategyInput,
  ReviewResult
> = step({ id: "review-implementation-strategy" })
  .prompt<ReviewImplementationStrategyInput, ReviewResult>(reviewImplementationStrategyPrompt, {
    agent: "reviewer",
    output: reviewOutput,
  })
  .do((review, input) => {
    if (reviewPasses(review)) {
      return sliceImplementationStoriesStep({
        featureDoc: input.featureDoc,
        implementationStrategy: input.implementationStrategy,
      });
    }

    if (input.attempt >= MAX_IMPLEMENTATION_DOC_REVIEW_ATTEMPTS) {
      return fail({
        code: "implementation_strategy_review_exhausted",
        message: `implementation-strategy.md failed review ${MAX_IMPLEMENTATION_DOC_REVIEW_ATTEMPTS} times in a row (last score ${review.score}/5).`,
        details: { review, implementationStrategyPath: input.implementationStrategy.path },
      });
    }

    return createOrImproveImplementationStrategyStep({
      featureDoc: input.featureDoc,
      previousReview: review,
      attempt: input.attempt + 1,
    });
  });
