import { Document, type StepFactory, state, step } from "@trailstep/authoring";
import { reviewImplementationStrategyStep } from "../review-implementation-strategy/step.js";
import {
  type CreateOrImproveImplementationStrategyInput,
  createOrImproveImplementationStrategyPrompt,
} from "./prompt.js";

export const createOrImproveImplementationStrategyStep: StepFactory<
  CreateOrImproveImplementationStrategyInput,
  Document
> = step({
  id: "create-or-improve-implementation-strategy",
})
  .prompt(createOrImproveImplementationStrategyPrompt, {
    agent: "planner",
    output: Document,
  })
  .do(async (implementationStrategy, input) => {
    await state.set("implementationStrategy", implementationStrategy);
    return reviewImplementationStrategyStep({
      featureDoc: input.featureDoc,
      implementationStrategy,
      attempt: input.attempt,
    });
  });
