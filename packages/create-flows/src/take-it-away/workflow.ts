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
      description: "Reviews isolated implementation docs and story diffs against methodology.",
    },
    implementer: {
      size: "medium",
      thinking: "medium",
      description: "Implements one story at a time using strict behavioral-red TDD.",
    },
  },
  start(input) {
    return createFeatureDocStep(input);
  },
});
