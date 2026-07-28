import { jsonSchema } from "@stepkit/authoring";

export interface TakeItAwayOutput extends Record<string, unknown> {
  readonly status: "implemented";
  readonly featureDocPath: string;
  readonly implementationDocPath: string;
  readonly storyCount: number;
  readonly completedStories: readonly string[];
  readonly summary: string;
}

export const takeItAwayOutput = jsonSchema<TakeItAwayOutput>({
  type: "object",
  properties: {
    status: { type: "string", const: "implemented" },
    featureDocPath: { type: "string" },
    implementationDocPath: { type: "string" },
    storyCount: { type: "number" },
    completedStories: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: [
    "status",
    "featureDocPath",
    "implementationDocPath",
    "storyCount",
    "completedStories",
    "summary",
  ],
  additionalProperties: false,
});

export function extractStoryTitle(storyContent: string, fallbackIndex: number): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(storyContent);
  return heading?.[1]?.trim() || `Story ${fallbackIndex}`;
}
