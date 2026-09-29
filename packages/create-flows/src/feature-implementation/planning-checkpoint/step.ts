import {
  type Document,
  fail,
  jsonSchema,
  type StepFactory,
  state,
  step,
} from "@trailstep/authoring";
import type { ContinuationResult } from "@trailstep/core";
import { createOrImproveImplementationStrategyStep } from "../create-or-improve-implementation-strategy/step.js";
import type { TakeItAwayWorkflowOptions } from "../shared/input-schema.js";
import type { ReviewResult } from "../shared/review-schema.js";
import { STORY_STATE_KEYS } from "../shared/story-state.js";
import { storyRouterStep } from "../story-router/step.js";

export interface PlanningCheckpointInput extends Record<string, unknown> {
  readonly featureDoc: Document;
  readonly implementationDoc: Document;
}

export interface PlanningCheckpointAnswer extends Record<string, unknown> {
  readonly action: "approve" | "revise" | "abort";
  readonly notes?: string;
}

const planningCheckpointAnswer = jsonSchema<PlanningCheckpointAnswer>({
  type: "object",
  properties: {
    action: { type: "string", enum: ["approve", "revise", "abort"] },
    notes: { type: "string" },
  },
  required: ["action"],
  additionalProperties: false,
});

export const planningCheckpointStep: StepFactory<PlanningCheckpointInput, PlanningCheckpointInput> =
  step({ id: "planning-checkpoint" })
    .wait(async (context) => {
      const input = context.input as PlanningCheckpointInput;
      const waitId = await nextPlanningCheckpointWaitId();
      return {
        id: waitId,
        kind: "input",
        message: [
          "Review the accepted implementation plan and story slices before execution.",
          `Implementation doc: ${input.implementationDoc.path}`,
          'Answer with {"action":"approve"} to continue, {"action":"revise","notes":"..."} to return to planning, or {"action":"abort","notes":"..."} to stop.',
        ].join("\n"),
        output: planningCheckpointAnswer,
      };
    })
    .do(async (context, input): Promise<ContinuationResult> => {
      const answer = readPlanningCheckpointAnswer(context.waits);

      if (!answer) {
        return fail({
          code: "planning_checkpoint_missing_answer",
          message: "Planning checkpoint resumed without a recorded human answer.",
        });
      }

      if (answer.action === "abort") {
        return fail({
          code: "planning_checkpoint_aborted",
          message: answer.notes?.trim() || "Human aborted at the planning checkpoint.",
          details: { implementationDocPath: input.implementationDoc.path },
        });
      }

      if (answer.action === "revise") {
        await state.set(STORY_STATE_KEYS.skipNextPlanningCheckpoint, true);
        return createOrImproveImplementationStrategyStep({
          featureDoc: input.featureDoc,
          previousReview: humanRevisionReview(answer.notes),
          attempt: 1,
        });
      }

      const activeStory = await state.get<Document>(STORY_STATE_KEYS.activeStory);
      if (!activeStory) {
        return fail({
          code: "planning_checkpoint_missing_active_story",
          message: "Planning checkpoint approved, but no active story was prepared for execution.",
          details: { implementationDocPath: input.implementationDoc.path },
        });
      }

      return storyRouterStep({ reason: "start-story", currentStory: activeStory });
    });

export async function shouldPauseForPlanningCheckpoint(): Promise<boolean> {
  const options = await state.get<TakeItAwayWorkflowOptions>(STORY_STATE_KEYS.workflowOptions);
  if (!(options?.planningCheckpoint.enabled ?? false)) {
    return false;
  }

  const skipNextCheckpoint = await state.get<boolean | null>(
    STORY_STATE_KEYS.skipNextPlanningCheckpoint,
  );
  if (skipNextCheckpoint) {
    await state.set(STORY_STATE_KEYS.skipNextPlanningCheckpoint, false);
    return false;
  }

  return true;
}

async function nextPlanningCheckpointWaitId(): Promise<string> {
  const previousCount =
    (await state.get<number | null>(STORY_STATE_KEYS.planningCheckpointCount)) ?? 0;
  const nextCount = previousCount + 1;
  await state.set(STORY_STATE_KEYS.planningCheckpointCount, nextCount);
  return nextCount === 1 ? "planning-checkpoint" : `planning-checkpoint-${nextCount}`;
}

function readPlanningCheckpointAnswer(
  waits: Readonly<Record<string, unknown>>,
): PlanningCheckpointAnswer | undefined {
  for (const [waitId, value] of Object.entries(waits)) {
    if (!waitId.startsWith("planning-checkpoint") || !isPlanningCheckpointAnswer(value)) {
      continue;
    }
    return value;
  }
  return undefined;
}

function isPlanningCheckpointAnswer(value: unknown): value is PlanningCheckpointAnswer {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const action = (value as { readonly action?: unknown }).action;
  return action === "approve" || action === "revise" || action === "abort";
}

function humanRevisionReview(notes: string | undefined): ReviewResult {
  const trimmedNotes = notes?.trim();
  return {
    score: 1,
    summary: trimmedNotes
      ? `Human requested planning revision: ${trimmedNotes}`
      : "Human requested planning revision at the checkpoint.",
    methodologyRatings: {
      tdd: 1,
      verticalSlicing: 1,
      tracerBullet: 1,
      dependencies: 1,
      architecture: 1,
    },
    requiredImprovements: [
      trimmedNotes || "Revise the implementation plan per human checkpoint feedback.",
    ],
  };
}
