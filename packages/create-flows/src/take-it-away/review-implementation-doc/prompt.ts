import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Document } from "@stepkit/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const methodology = readFileSync(join(here, "../shared/feature-methodology.md"), "utf8");
const implementationDocFormat = readFileSync(
  join(here, "../shared/implementation-doc-format.md"),
  "utf8",
);

export interface ReviewImplementationDocInput extends Record<string, unknown> {
  readonly featureDoc: Document;
  readonly implementationDoc: Document;
  readonly attempt: number;
}

export function reviewImplementationDocPrompt({
  input,
}: {
  readonly input: ReviewImplementationDocInput;
}): string {
  return [
    methodology,
    "",
    implementationDocFormat,
    "",
    "## Feature doc",
    "",
    input.featureDoc.content,
    "",
    "## Implementation doc under review",
    "",
    input.implementationDoc.content,
    "",
    "## Task",
    "",
    "Critically review the implementation doc above against the feature doc and the methodology. Review for:",
    "",
    "- traceability to the feature doc;",
    "- strict behavioral-red TDD story design;",
    "- vertical slices rather than horizontal tasks;",
    "- a clear tracer-bullet strategy;",
    "- hard dependency labels and topological ordering;",
    "- acceptance criteria and validation commands;",
    "- story instructions self-contained enough for an implementer who will only see one story at a time;",
    "- correct use of the `<!-- stepkit-story-boundary -->` marker between stories, and that no story-critical detail lives only in the overview section above the first marker.",
    "",
    "Do not edit the implementation doc. Respond only with the structured review.",
  ].join("\n");
}
