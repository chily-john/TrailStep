import { step } from "@stepkit/authoring";
import { createFeatureDocStep } from "../../feature-implementation/create-feature-doc/step.js";
import { takeItAwayInput } from "../../feature-implementation/shared/input-schema.js";
import { grillPrompt } from "./prompt.js";

export const grillStep = step({ id: "grill" })
  .prompt(grillPrompt, {
    agent: "grillingAgent",
    mode: "interactive",
    output: takeItAwayInput,
  })
  .do((output) => createFeatureDocStep(output));
