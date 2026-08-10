import { defineWorkflow, shape } from "@trailstep/authoring";
import { takeItAwayOutput } from "../feature-implementation/shared/output-schema.js";
import { grillStep } from "./grill/step.js";

export const grillItAway = defineWorkflow({
  id: "grill-it-away",
  description: "Interactively grills the user until it understands the requested feature.",
  inputShape: shape<Record<string, never>>({}),
  outputShape: takeItAwayOutput,
  agents: {
    grillingAgent: {
      size: "medium",
      thinking: "medium",
      description: "Grills the user until it understands the requested feature.",
    },
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
  start() {
    return grillStep();
  },
});
