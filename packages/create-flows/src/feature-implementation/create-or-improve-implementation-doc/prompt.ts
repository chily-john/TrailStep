import type { Document } from "@trailstep/authoring";
import { list, promptSections, section } from "@trailstep/authoring";
import methodologyFragment from "../shared/feature-methodology.md?raw";
import implementationDocFormatFragment from "../shared/implementation-doc-format.md?raw";
import projectArchitectureGuidanceFragment from "../shared/project-architecture-guidance.md?raw";
import type { ReviewResult } from "../shared/review-schema.js";

const fragments = {
  methodology: methodologyFragment.trimEnd(),
  architectureGuidance: projectArchitectureGuidanceFragment.trimEnd(),
  implementationDocFormat: implementationDocFormatFragment.trimEnd(),
};

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
      ? "Create `implementation-doc.md` from the feature doc above, following the format exactly enough that stories can later be split mechanically on the `<!-- trailstep-story-boundary -->` marker and scoped context can be selected from balanced `<context>` blocks with audience/story/phase metadata."
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
      `${taskBody}\n\nDesign stories around strict behavioral-red TDD, vertical slicing, tracer-bullet methodology, and hard dependency labels only. Topologically order stories by dependency. Keep each story implementation-ready and self-contained. Put only genuinely shared, role-appropriate details in balanced \`<context>\` ... \`</context>\` blocks with explicit \`audience\`, \`stories\`, and \`phases\` metadata; do not put reviewer-only guidance or the whole plan in implementer context. Repeat details inside individual stories when only selected stories need them.`,
    ),
  );
}
