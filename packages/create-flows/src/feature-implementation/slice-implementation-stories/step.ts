import { Document, type StepFactory, state, step } from "@trailstep/authoring";
import { splitImplementationStoriesStep } from "../split-implementation-stories/step.js";
import {
  type SliceImplementationStoriesInput,
  sliceImplementationStoriesPrompt,
} from "./prompt.js";

export const sliceImplementationStoriesStep: StepFactory<
  SliceImplementationStoriesInput,
  Document
> = step({ id: "slice-implementation-stories" })
  .prompt(sliceImplementationStoriesPrompt, {
    agent: "slicer",
    output: Document,
  })
  .do(async (implementationDoc, input) => {
    await state.set("implementationDoc", implementationDoc);
    return splitImplementationStoriesStep({ featureDoc: input.featureDoc, implementationDoc });
  });
