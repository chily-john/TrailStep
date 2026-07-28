import { promptSections, section } from "@stepkit/authoring";
import type { TakeItAwayInput } from "../shared/input-schema.js";
import featureDocFormat from "../shared/feature-doc-format.md";
import methodology from "../shared/feature-methodology.md";

export function createFeatureDocPrompt({ input }: { readonly input: TakeItAwayInput }): string {
  return promptSections(
    methodology,
    featureDocFormat,
    section("Conversation / feature request", input.conversation),
    section(
      "Task",
      'Write `feature-doc.md` following the format above, based on the conversation/request. Make it detailed enough that another agent can plan implementation without reading the original conversation. Preserve uncertainty explicitly in "Open Questions and Assumptions" — do not invent missing product decisions.',
    ),
  );
}
