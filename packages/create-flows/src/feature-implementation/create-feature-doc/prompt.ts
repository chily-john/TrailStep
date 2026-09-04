import { promptSections, section } from "@trailstep/authoring";
import featureDocFormatFragment from "../shared/feature-doc-format.md?raw";
import methodologyFragment from "../shared/feature-methodology.md?raw";
import type { TakeItAwayInput } from "../shared/input-schema.js";

const fragments = {
  methodology: methodologyFragment.trimEnd(),
  featureDocFormat: featureDocFormatFragment.trimEnd(),
};

export function createFeatureDocPrompt({ input }: { readonly input: TakeItAwayInput }): string {
  return promptSections(
    fragments.methodology,
    fragments.featureDocFormat,
    section("Conversation / feature request", input.conversation),
    section(
      "Distillation guardrails",
      [
        "Treat the conversation/request as evidence, not as permission to finish a product vision.",
        "Preserve the user's actual must-have outcome, explicit constraints, uncertainty, and explicit non-goals; include implied scope limits only when tied to clear evidence.",
        "Do not invent scope, acceptance criteria, integrations, personas, product decisions, or polish that the user did not ask for.",
        "When a broad request includes brainstorming, ambitions, or adjacent possibilities, keep the confirmed current scope in the must-have/in-scope sections and move nonessential ideas to Optional / Future Ideas.",
        "If a detail is unknown, record it as an assumption or open question instead of choosing an answer.",
        "A later planning agent may implement the must-have and in-scope sections; optional/future ideas are context only and must not become story scope unless explicitly promoted by the user.",
      ].join("\n"),
    ),
    section(
      "Task",
      "Write `feature-doc.md` following the format above, based on the conversation/request. Make it detailed enough that another agent can plan implementation without reading the original conversation, while preserving scope boundaries and uncertainty. Do not inflate the request into an idealized product spec.",
    ),
  );
}
