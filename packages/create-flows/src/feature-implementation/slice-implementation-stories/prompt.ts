import type { Document } from "@trailstep/authoring";
import { promptSections, section } from "@trailstep/authoring";
import methodologyFragment from "../shared/feature-methodology.md?raw";
import implementationDocFormatFragment from "../shared/implementation-doc-format.md?raw";

const fragments = {
  methodology: methodologyFragment.trimEnd(),
  implementationDocFormat: implementationDocFormatFragment.trimEnd(),
};

export interface SliceImplementationStoriesInput extends Record<string, unknown> {
  readonly featureDoc: Document;
  readonly implementationStrategy: Document;
}

export function sliceImplementationStoriesPrompt({
  input,
}: {
  readonly input: SliceImplementationStoriesInput;
}): string {
  return promptSections(
    fragments.methodology,
    fragments.implementationDocFormat,
    section("Feature doc", input.featureDoc.content),
    section("Reviewed implementation strategy", input.implementationStrategy.content),
    section(
      "Task",
      "Generate only the implementation-ready story document to be mechanically split for execution. Consume the feature doc and reviewed strategy, but do not copy broad architecture/risk planning into overview prose that implementers will not see. Use `<!-- trailstep-story-boundary -->` only to delimit story bodies. Keep each story self-contained for its implementer; put genuinely shared implementer-only phase context in balanced `<context>` blocks with metadata. Do not add a separate strategy section, reviewer notes, or non-story planning artifact content.",
    ),
  );
}
