import { defineWorkflow } from "@trailstep/authoring";
import { initializeTakeItAwayStep } from "../feature-implementation/initialize-take-it-away/step.js";
import { featureImplementationAgents } from "../feature-implementation/shared/agent-roles.js";
import { takeItAwayInput } from "../feature-implementation/shared/input-schema.js";
import { takeItAwayOutput } from "../feature-implementation/shared/output-schema.js";

export type { TakeItAwayInput } from "../feature-implementation/shared/input-schema.js";

export const takeItAway = defineWorkflow({
  id: "take-it-away",
  description:
    "Turns an already-organic conversation/feature request into a reviewed implementation plan, then implements it story by story.",
  inputShape: takeItAwayInput,
  outputShape: takeItAwayOutput,
  agents: featureImplementationAgents,
  start(input) {
    return initializeTakeItAwayStep(input);
  },
});
