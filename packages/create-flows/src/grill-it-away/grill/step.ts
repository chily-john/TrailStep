import { step } from "@trailstep/authoring";
import { initializeTakeItAwayStep } from "../../feature-implementation/initialize-take-it-away/step.js";
import { takeItAwayInput } from "../../feature-implementation/shared/input-schema.js";
import { grillPrompt } from "./prompt.js";

export const grillStep = step({ id: "grill" })
  .prompt(grillPrompt, {
    agent: "grillingAgent",
    mode: "interactive",
    output: takeItAwayInput,
  })
  .do((output) => initializeTakeItAwayStep(output));
