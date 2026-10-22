import type { Document } from "@trailstep/authoring";

import type {
  BlockedStoryPhase,
  BlockedStoryRouteSourceReason,
} from "../shared/story/story-state.js";

export interface StoryRouterInput extends Record<string, unknown> {
  readonly reason:
    | "start-story"
    | "retry-story"
    | "story-completed"
    | "failed-review"
    | "failed-validation"
    | {
        readonly type: "blocked";
        readonly sourceReason: BlockedStoryRouteSourceReason;
        readonly blockedPhase: BlockedStoryPhase;
        readonly blockedReason: string;
        readonly code: string;
        readonly metadata?: Record<string, unknown>;
      };
  readonly currentStory?: Document;
}

export interface RouterRetryCounts {
  readonly reviewRetryCount: number;
  readonly validationRetryCount: number;
}

export type RetryRouteSourceReason = "failed-review" | "failed-validation";

export type BlockedStoryRoute = Extract<StoryRouterInput["reason"], { readonly type: "blocked" }>;
