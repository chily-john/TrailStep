import type { Document } from "@stepkit/sdk";
import { documentOutput, state, step } from "@stepkit/sdk";
import { createOrImproveImplementationDocStep } from "../create-or-improve-implementation-doc/step.js";
import type { TakeItAwayInput } from "../shared/input-schema.js";
import { createFeatureDocPrompt } from "./prompt.js";


export const createFeatureDocStep = step({ id: "create-feature-doc" })
    .prompt<TakeItAwayInput, Document>(createFeatureDocPrompt, {
        agent: "featureWriter",
        output: documentOutput,
    })
    .do(async (featureDoc) => {
        await state.set("featureDoc", featureDoc);
        return createOrImproveImplementationDocStep({ featureDoc, attempt: 1 });
    });
