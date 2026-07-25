import { defineWorkflow } from "@stepkit/sdk";
import { createFeatureDocStep } from "./create-feature-doc/step.js";
import { takeItAwayInput } from "./shared/input-schema.js";
import { takeItAwayOutput } from "./shared/output-schema.js";

export type { TakeItAwayInput } from "./shared/input-schema.js";

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
      size: "medium",
      thinking: "medium",
      description: "Reviews implementation docs and story implementations against methodology.",
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
