import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TakeItAwayInput } from "../shared/input-schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const methodology = readFileSync(join(here, "../shared/feature-methodology.md"), "utf8");
const featureDocFormat = readFileSync(join(here, "../shared/feature-doc-format.md"), "utf8");

export function createFeatureDocPrompt({ input }: { readonly input: TakeItAwayInput }): string {
  return [
    methodology,
    "",
    featureDocFormat,
    "",
    "## Conversation / feature request",
    "",
    input.conversation,
    "",
    "## Task",
    "",
    'Write `feature-doc.md` following the format above, based on the conversation/request. Make it detailed enough that another agent can plan implementation without reading the original conversation. Preserve uncertainty explicitly in "Open Questions and Assumptions" — do not invent missing product decisions.',
  ].join("\n");
}
