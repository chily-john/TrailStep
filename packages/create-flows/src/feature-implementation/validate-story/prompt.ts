import type { Document } from "@trailstep/authoring";
import type { ExploreStoryOutput } from "../explore-story/prompt.js";
import type { ImplementGreenOutput } from "../implement-green/prompt.js";
import type { WriteRedTestsOutput } from "../write-red-tests/prompt.js";

export interface ValidateStoryInput extends Record<string, unknown> {
  readonly currentStory: Document;
  readonly explorationBrief?: ExploreStoryOutput;
  readonly redTestSummary?: WriteRedTestsOutput;
  readonly implementationSummary?: ImplementGreenOutput;
  readonly attempt: number;
}

export interface ValidationCommandResult extends Record<string, unknown> {
  readonly command: string;
  readonly result: string;
}

export interface ValidateStoryOutput extends Record<string, unknown> {
  readonly blocked: boolean;
  readonly blockedReason?: string;
  readonly summary: string;
  readonly commands: readonly ValidationCommandResult[];
  readonly validationPassed: boolean;
}
