import type { Document } from "@trailstep/authoring";
import { fail, state, step } from "@trailstep/authoring";
import type { ContinuationResult } from "@trailstep/core";
import { runGit } from "../commit-reviewed-story/run-git.js";
import { exploreStoryStep } from "../explore-story/step.js";
import {
  incrementStoryPhaseAttempt,
  STORY_STATE_KEYS,
  type StoryPreflightStatus,
  type StoryRouterState,
} from "../shared/story-state.js";

export interface StoryIsolationPreflightInput extends Record<string, unknown> {
  readonly currentStory: Document;
}

export const storyIsolationPreflightStep = step({ id: "story-isolation-preflight" }).do(
  async ({ currentStory }: StoryIsolationPreflightInput): Promise<ContinuationResult> => {
    const result = await runStoryIsolationPreflight(currentStory);
    if (!result.ok) {
      return result.failure;
    }

    await state.set(STORY_STATE_KEYS.activePhase, "explore-story");
    await incrementStoryPhaseAttempt("explore-story");
    const implementationContext =
      (await state.get<string | null>(STORY_STATE_KEYS.activeStoryContext)) ?? undefined;
    return exploreStoryStep({ currentStory, implementationContext });
  },
);

export async function runStoryIsolationPreflight(
  currentStory: Document,
): Promise<StoryIsolationPreflightResult> {
  await state.set(STORY_STATE_KEYS.activePhase, "story-isolation-preflight");
  await incrementStoryPhaseAttempt("story-isolation-preflight");

  const blockedReplay = await loadBlockedReplayPreflightState(currentStory);
  if (blockedReplay) {
    await state.set(STORY_STATE_KEYS.storyBaseline, blockedReplay.baseline);
    await state.set(STORY_STATE_KEYS.activeStoryStartCommit, { commit: blockedReplay.baseline });
    await state.set(STORY_STATE_KEYS.latestPreflightStatus, {
      ok: true,
      code: "story_preflight_passed",
      message: "Story isolation preflight passed.",
      baseline: blockedReplay.baseline,
    } satisfies StoryPreflightStatus);
    return { ok: true, baseline: blockedReplay.baseline };
  }

  const cwd = state.cwd;
  if (!cwd) {
    return preflightFailure(
      "story_preflight_missing_cwd",
      "Cannot start story implementation because the TrailStep workflow cwd is unavailable. Retry from a valid project checkout so TrailStep can record a git story baseline.",
      { storyPath: currentStory.path },
    );
  }

  const insideWorkTree = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!insideWorkTree.ok || insideWorkTree.stdout !== "true") {
    return preflightFailure(
      "story_preflight_not_git_worktree",
      "Cannot start story implementation because the workflow cwd is not a valid git worktree. Run take-it-away/grill-it-away from a git repository with a clean story boundary.",
      {
        storyPath: currentStory.path,
        cwd,
        gitError: insideWorkTree.ok ? undefined : insideWorkTree.error,
      },
    );
  }

  const head = await runGit(["rev-parse", "HEAD"], cwd);
  if (!head.ok || head.stdout.length === 0) {
    return preflightFailure(
      "story_preflight_missing_head",
      "Cannot start story implementation because `git rev-parse HEAD` did not produce a usable baseline commit. Create an initial commit or fix the git repository, then retry.",
      {
        storyPath: currentStory.path,
        cwd,
        gitError: head.ok ? "No commit was returned." : head.error,
      },
    );
  }

  const existingBaseline = await state.get<string | null>(STORY_STATE_KEYS.storyBaseline);
  const baseline = existingBaseline ?? head.stdout;
  const reachable = await runGit(["cat-file", "-e", `${baseline}^{commit}`], cwd);
  if (!reachable.ok) {
    return preflightFailure(
      "story_preflight_unreachable_baseline",
      `Cannot start story implementation because the recorded story baseline \`${baseline}\` is missing or unreachable. Fix the checkout or retry after restoring a valid story boundary.`,
      { storyPath: currentStory.path, cwd, baseline, gitError: reachable.error },
    );
  }

  const status = await runGit(["status", "--short"], cwd);
  if (!status.ok) {
    return preflightFailure(
      "story_preflight_status_failed",
      "Cannot start story implementation because TrailStep could not inspect `git status --short`. Fix git status inspection and retry.",
      { storyPath: currentStory.path, cwd, baseline, gitError: status.error },
    );
  }

  if (status.stdout.trim().length > 0) {
    return preflightFailure(
      "story_preflight_dirty_worktree",
      "Cannot start story implementation because the working tree is dirty before the story begins. Commit, stash, or otherwise restore a clean story boundary, then retry.",
      { storyPath: currentStory.path, cwd, baseline, statusShort: status.stdout },
    );
  }

  await state.set(STORY_STATE_KEYS.storyBaseline, baseline);
  await state.set(STORY_STATE_KEYS.activeStoryStartCommit, { commit: baseline });
  await state.set(STORY_STATE_KEYS.latestPreflightStatus, {
    ok: true,
    code: "story_preflight_passed",
    message: "Story isolation preflight passed.",
    baseline,
  } satisfies StoryPreflightStatus);

  return { ok: true, baseline };
}

type StoryIsolationPreflightResult =
  | { readonly ok: true; readonly baseline: string }
  | { readonly ok: false; readonly failure: ContinuationResult };

async function loadBlockedReplayPreflightState(
  currentStory: Document,
): Promise<{ readonly baseline: string } | null> {
  const routerState = await state.get<StoryRouterState | null>(
    STORY_STATE_KEYS.latestStoryRouterState,
  );
  if (
    routerState?.route !== "blocked" ||
    routerState.activeStory.path !== currentStory.path ||
    routerState.activeStory.content !== currentStory.content
  ) {
    return null;
  }

  const baseline =
    (await state.get<string | null>(STORY_STATE_KEYS.storyBaseline)) ??
    (await state.get<{ readonly commit?: string } | null>(STORY_STATE_KEYS.activeStoryStartCommit))
      ?.commit;
  return baseline ? { baseline } : null;
}

async function preflightFailure(
  code: string,
  message: string,
  details: Record<string, unknown>,
): Promise<StoryIsolationPreflightResult> {
  await state.set(STORY_STATE_KEYS.latestPreflightStatus, {
    ok: false,
    code,
    message,
    baseline: typeof details.baseline === "string" ? details.baseline : undefined,
  } satisfies StoryPreflightStatus);
  return { ok: false, failure: fail({ code, message, details }) };
}
