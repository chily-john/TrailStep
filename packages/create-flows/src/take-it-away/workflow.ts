import { defineWorkflow } from "@trailstep/authoring";
import { createFeatureDocStep } from "../feature-implementation/create-feature-doc/step.js";
import { takeItAwayInput } from "../feature-implementation/shared/input-schema.js";
import { takeItAwayOutput } from "../feature-implementation/shared/output-schema.js";

export type { TakeItAwayInput } from "../feature-implementation/shared/input-schema.js";

export const takeItAway = defineWorkflow({
  id: "take-it-away",
  description:
    "Turns an already-organic conversation/feature request into a reviewed implementation plan, then implements it story by story.",
  inputShape: takeItAwayInput,
  outputShape: takeItAwayOutput,
  agents: {
    featureWriter: {
      size: "medium",
      thinking: "medium",
      description: "Turns a conversation/feature request into a standalone feature doc.",
    },
    planner: {
      size: "large",
      thinking: "high",
      description:
        "Creates or improves the implementation doc: architecture-aware, TDD/vertical-slice/tracer-bullet story design.",
    },
    reviewer: {
      size: "large",
      thinking: "high",
      description: "Reviews implementation docs before story execution.",
    },
    storyExplorer: {
      size: "small",
      thinking: "low",
      description: "Finds story-specific files, seams, and validation hints without editing.",
    },
    testWriter: {
      size: "medium",
      thinking: "medium",
      description: "Writes focused behavioral red tests for the active story.",
    },
    storyImplementer: {
      size: "medium",
      thinking: "medium",
      description: "Implements the smallest green slice for the active story.",
    },
    validator: {
      size: "small",
      thinking: "low",
      description: "Runs focused validation commands and reports concise results.",
    },
    storyReviewer: {
      size: "large",
      thinking: "high",
      description: "Reviews isolated story diffs and phase evidence before commit.",
    },
  },
  start(input) {
    return createFeatureDocStep(input);
  },
});
