import { defineWorkflow, shape } from "@trailstep/authoring";
import { featureImplementationAgents } from "../shared/agent-roles.js";
import { takeItAwayOutput } from "../shared/output-schema.js";
import { grillStep } from "./grill/step.js";

export const grillItAway = defineWorkflow({
  id: "grill-it-away",
  description:
    "Interactively grills the user until it understands the requested feature. The grilling is interactive and waits for the user between follow-up questions: watch the run with `trst_watch`, answer the pending wait with `trst_answer`, and continue with `trst_resume` while the user responds; once confident, it hands off the full raw conversation transcript to feature implementation.",
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
