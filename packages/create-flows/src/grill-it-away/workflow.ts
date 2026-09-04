import { defineWorkflow, shape } from "@trailstep/authoring";
import { featureImplementationAgents } from "../feature-implementation/shared/agent-roles.js";
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
    ...featureImplementationAgents,
  },
  start() {
    return grillStep();
  },
});
