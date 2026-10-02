import type { Document } from "@trailstep/authoring";
import { list, promptSections, section } from "@trailstep/authoring";
import methodologyFragment from "../shared/feature-methodology.md?raw";
import implementationStrategyFormatFragment from "../shared/implementation-strategy-format.md?raw";

const fragments = {
  methodology: methodologyFragment.trimEnd(),
  implementationStrategyFormat: implementationStrategyFormatFragment.trimEnd(),
};

export interface ReviewImplementationStrategyInput extends Record<string, unknown> {
  readonly featureDoc: Document;
  readonly implementationStrategy: Document;
  readonly attempt: number;
}

export function reviewImplementationStrategyPrompt({
  input,
}: {
  readonly input: ReviewImplementationStrategyInput;
}): string {
  const reviewCriteria = list([
    "traceability to the feature doc",
    "sound architecture and integration planning",
    "explicit risk and uncertainty handling",
    "a clear tracer-bullet strategy",
    "hard dependency reasoning without over-constraining",
    "testing and validation strategy",
    "useful slicing guidance for a later story slicer",
    "absence of `<!-- trailstep-story-boundary -->` markers or executable story bodies",
  ]);

  return promptSections(
    fragments.methodology,
    fragments.implementationStrategyFormat,
    section("Feature doc", input.featureDoc.content),
    section("Implementation strategy under review", input.implementationStrategy.content),
    section(
      "Task",
      `Critically review the implementation strategy above against the feature doc and the methodology. Review for:\n\n${reviewCriteria}\n\nDo not edit the strategy. Respond only with the structured review.`,
    ),
  );
}
