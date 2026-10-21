import { jsonSchema } from "@trailstep/authoring";

export type TakeItAwayPullRequestStatus = "created" | "existing" | "skipped" | "disabled";

export interface TakeItAwayPullRequestOutput extends Record<string, unknown> {
  readonly status: TakeItAwayPullRequestStatus;
  readonly url?: string;
  readonly warning?: string;
  readonly commands?: readonly string[];
}

export interface TakeItAwayOutput extends Record<string, unknown> {
  readonly status: "implemented";
  readonly featureDocPath: string;
  readonly implementationDocPath: string;
  readonly storyCount: number;
  readonly completedStories: readonly string[];
  readonly summary: string;
  readonly warnings?: readonly string[];
  readonly pullRequest?: TakeItAwayPullRequestOutput;
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
    warnings: { type: "array", items: { type: "string" } },
    pullRequest: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["created", "existing", "skipped", "disabled"] },
        url: { type: "string" },
        warning: { type: "string" },
        commands: { type: "array", items: { type: "string" } },
      },
      required: ["status"],
      additionalProperties: false,
    },
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
