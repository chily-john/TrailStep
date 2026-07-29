import { jsonSchema } from "@stepkit/authoring";

import { REVIEW_PASS_THRESHOLD } from "./constants.js";

export interface MethodologyRatings extends Record<string, unknown> {
  readonly tdd: number;
  readonly verticalSlicing: number;
  readonly tracerBullet: number;
  readonly dependencies: number;
  readonly architecture: number;
}

export interface ReviewResult extends Record<string, unknown> {
  readonly score: number;
  readonly summary: string;
  readonly methodologyRatings: MethodologyRatings;
  readonly requiredImprovements: readonly string[];
}

const RATING_SCHEMA = { type: "integer", minimum: 1, maximum: 5 } as const;

export const reviewOutput = jsonSchema<ReviewResult>({
  type: "object",
  properties: {
    score: RATING_SCHEMA,
    summary: { type: "string" },
    methodologyRatings: {
      type: "object",
      properties: {
        tdd: RATING_SCHEMA,
        verticalSlicing: RATING_SCHEMA,
        tracerBullet: RATING_SCHEMA,
        dependencies: RATING_SCHEMA,
        architecture: RATING_SCHEMA,
      },
      required: ["tdd", "verticalSlicing", "tracerBullet", "dependencies", "architecture"],
      additionalProperties: false,
    },
    requiredImprovements: { type: "array", items: { type: "string" } },
  },
  required: ["score", "summary", "methodologyRatings", "requiredImprovements"],
  additionalProperties: false,
});

export function reviewPasses(review: ReviewResult): boolean {
  return review.score >= REVIEW_PASS_THRESHOLD;
}
