import { defineWorkflow } from "@trailstep/authoring";
import { initializeTakeItAwayStep } from "../feature-implementation/initialize-take-it-away/step.js";
import { featureImplementationAgents } from "../shared/agent-roles.js";
import { takeItAwayInput } from "../shared/input-schema.js";
import { takeItAwayOutput } from "../shared/output-schema.js";

export type { TakeItAwayInput } from "../shared/input-schema.js";

export const takeItAway = defineWorkflow({
  id: "take-it-away",
  description:
    "Turns an already-organic conversation/feature request into a reviewed implementation plan, then implements it story by story. `conversation` is required and must be the full raw transcript of the conversation or feature request (not a summary); `autoCommit` defaults to true; `pullRequest` defaults to enabled (base `main`, remote `origin`, draft false) with optional title/body; and `planningCheckpoint` defaults to disabled.",
  inputShape: takeItAwayInput,
  outputShape: takeItAwayOutput,
  agents: featureImplementationAgents,
  start(input) {
    return initializeTakeItAwayStep(input);
  },
});
