import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Document } from "@stepkit/sdk";
import type { ReviewResult } from "../shared/review-schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const methodology = readFileSync(join(here, "../shared/feature-methodology.md"), "utf8");
const implementationDocFormat = readFileSync(
  join(here, "../shared/implementation-doc-format.md"),
  "utf8",
);
const architectureGuidance = readFileSync(
  join(here, "../shared/project-architecture-guidance.md"),
  "utf8",
);

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
  return [
    methodology,
    "",
    architectureGuidance,
    "",
    implementationDocFormat,
    "",
    "## Feature doc",
    "",
    input.featureDoc.content,
    "",
    "## Task",
    "",
    ...(input.previousReview === undefined
      ? [
          "Create `implementation-doc.md` from the feature doc above, following the format exactly enough that stories can later be split mechanically on the `<!-- stepkit-story-boundary -->` marker.",
        ]
      : [
          `This is improvement attempt ${input.attempt}. A previous review scored this plan ${input.previousReview.score}/5: ${input.previousReview.summary}`,
          "",
          "Required improvements to address, without discarding what already works:",
          "",
          ...input.previousReview.requiredImprovements.map((improvement) => `- ${improvement}`),
        ]),
    "",
    "Design stories around strict behavioral-red TDD, vertical slicing, tracer-bullet methodology, and hard dependency labels only. Topologically order stories by dependency. Write every story as implementation-ready instructions for an implementer who will only see that one story's content.",
  ].join("\n");
}
