import { state, step } from "@trailstep/authoring";
import type { ContinuationResult } from "@trailstep/core";
import { createFeatureDocStep } from "../create-feature-doc/step.js";
import {
  normalizeTakeItAwayWorkflowOptions,
  type TakeItAwayInput,
} from "../shared/input-schema.js";
import { STORY_STATE_KEYS } from "../shared/story-state.js";

export const initializeTakeItAwayStep = step({ id: "initialize-take-it-away" }).do(
  async (input: TakeItAwayInput): Promise<ContinuationResult> => {
    await state.set(STORY_STATE_KEYS.workflowOptions, normalizeTakeItAwayWorkflowOptions(input));
    await state.set(STORY_STATE_KEYS.workflowWarnings, []);
    return createFeatureDocStep(input);
  },
);
