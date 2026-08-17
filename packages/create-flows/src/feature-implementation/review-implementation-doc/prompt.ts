import type { Document } from "@trailstep/authoring";
import { list, promptSections, section } from "@trailstep/authoring";
import methodologyFragment from "../shared/feature-methodology.md?raw";
import implementationDocFormatFragment from "../shared/implementation-doc-format.md?raw";

const fragments = {
  methodology: methodologyFragment.trimEnd(),
  implementationDocFormat: implementationDocFormatFragment.trimEnd(),
};

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
  const reviewCriteria = list([
    "traceability to the feature doc",
    "strict behavioral-red TDD story design",
    "vertical slices rather than horizontal tasks",
    "a clear tracer-bullet strategy",
    "hard dependency labels and topological ordering",
    "acceptance criteria and validation commands",
    "story instructions self-contained enough for an implementer who will only see one story plus the prepended shared context at a time",
    "correct use of balanced `<context>` ... `</context>` blocks for shared implementer context",
    "correct use of the `<!-- trailstep-story-boundary -->` marker between stories, and that no story-critical detail lives only in non-context overview text above the first marker",
  ]);

  return promptSections(
    fragments.methodology,
    fragments.implementationDocFormat,
    section("Feature doc", input.featureDoc.content),
    section("Implementation doc under review", input.implementationDoc.content),
    section(
      "Task",
      `Critically review the implementation doc above against the feature doc and the methodology. Review for:\n\n${reviewCriteria}\n\nDo not edit the implementation doc. Respond only with the structured review.`,
    ),
  );
}
