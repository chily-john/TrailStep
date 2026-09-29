import type { Document } from "@trailstep/authoring";
import { list, promptSections, section } from "@trailstep/authoring";
import methodologyFragment from "../shared/feature-methodology.md?raw";
import implementationStrategyFormatFragment from "../shared/implementation-strategy-format.md?raw";
import projectArchitectureGuidanceFragment from "../shared/project-architecture-guidance.md?raw";
import type { ReviewResult } from "../shared/review-schema.js";

const fragments = {
  methodology: methodologyFragment.trimEnd(),
  architectureGuidance: projectArchitectureGuidanceFragment.trimEnd(),
  implementationStrategyFormat: implementationStrategyFormatFragment.trimEnd(),
};

export interface CreateOrImproveImplementationStrategyInput extends Record<string, unknown> {
  readonly featureDoc: Document;
  readonly previousReview?: ReviewResult;
  readonly attempt: number;
}

export function createOrImproveImplementationStrategyPrompt({
  input,
}: {
  readonly input: CreateOrImproveImplementationStrategyInput;
}): string {
  const taskBody =
    input.previousReview === undefined
      ? "Create `implementation-strategy.md` from the feature doc above. This is architecture/risk planning only, not executable story generation."
      : promptSections(
          `This is improvement attempt ${input.attempt}. A previous review scored this strategy ${input.previousReview.score}/5: ${input.previousReview.summary}`,
          `Required improvements to address, without discarding what already works:\n\n${list(input.previousReview.requiredImprovements)}`,
        );

  return promptSections(
    fragments.methodology,
    fragments.architectureGuidance,
    fragments.implementationStrategyFormat,
    section("Feature doc", input.featureDoc.content),
    section(
      "Task",
      `${taskBody}\n\nPlan the implementation architecture, risks, tracer-bullet path, hard dependencies, test strategy, and slicing guidance. Do not include story boundary markers and do not write full story bodies; a separate slicer will turn this strategy into implementation-ready stories.`,
    ),
  );
}
