import type { Document } from "@stepkit/authoring";
import { list, loadFragments, promptSections, section } from "@stepkit/authoring";
import type { ReviewResult } from "../shared/review-schema.js";

const fragments = loadFragments(import.meta.dirname, {
  methodology: "../shared/feature-methodology.md",
  architectureGuidance: "../shared/project-architecture-guidance.md",
  implementationDocFormat: "../shared/implementation-doc-format.md",
});

export interface CreateOrImproveImplementationDocInput extends Record<string, unknown> {
  readonly featureDoc: Document;
  readonly previousReview?: ReviewResult;
  readonly attempt: number;
}

export function createOrImproveImplementationDocPrompt({
  input,
}: {
  readonly input: CreateOrImproveImplementationDocInput;
}): string {
  const taskBody =
    input.previousReview === undefined
      ? "Create `implementation-doc.md` from the feature doc above, following the format exactly enough that stories can later be split mechanically on the `<!-- stepkit-story-boundary -->` marker."
      : promptSections(
          `This is improvement attempt ${input.attempt}. A previous review scored this plan ${input.previousReview.score}/5: ${input.previousReview.summary}`,
          `Required improvements to address, without discarding what already works:\n\n${list(input.previousReview.requiredImprovements)}`,
        );

  return promptSections(
    fragments.methodology,
    fragments.architectureGuidance,
    fragments.implementationDocFormat,
    section("Feature doc", input.featureDoc.content),
    section(
      "Task",
      `${taskBody}\n\nDesign stories around strict behavioral-red TDD, vertical slicing, tracer-bullet methodology, and hard dependency labels only. Topologically order stories by dependency. Write every story as implementation-ready instructions for an implementer who will only see that one story's content.`,
    ),
  );
}
