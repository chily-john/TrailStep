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
  start() {
    return grillStep();
  },
});
