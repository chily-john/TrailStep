import type { Document } from "@trailstep/authoring";
import { done, fail, state, step } from "@trailstep/authoring";
import type { ContinuationResult } from "@trailstep/core";
import { extractStoryTitle, type TakeItAwayOutput } from "../shared/output-schema.js";
import {
  type ActiveStoryStartCommit,
  resetActiveStoryStartCommit,
  STORY_STATE_KEYS,
} from "../shared/story-state.js";
import { runGit } from "./run-git.js";

export interface CommitReviewedStoryInput extends Record<string, unknown> {
  readonly currentStory: Document;
  readonly implementationSummary?: string;
}

export const commitReviewedStoryStep = step({ id: "commit-reviewed-story" }).do(
  async (input: CommitReviewedStoryInput): Promise<ContinuationResult> => {
    const activeStory =
      (await state.get<Document | null>(STORY_STATE_KEYS.activeStory)) ?? input.currentStory;

    if (storyAutoCommitEnabled()) {
      const commitResult = await commitReviewedStoryChanges(
        activeStory,
        input.implementationSummary,
      );
      if (!commitResult.ok) {
        return fail({
          code: commitResult.code,
          message: commitResult.message,
          details: commitResult.details,
        });
      }
    }

    return completeReviewedStory(activeStory);
  },
);

function storyAutoCommitEnabled(): boolean {
  const mode = process.env.TRAILSTEP_STORY_COMMIT_MODE;
  return ["1", "true", "enabled", "worktree"].includes(mode?.toLowerCase() ?? "");
}

async function commitReviewedStoryChanges(
  activeStory: Document,
  implementationSummary: string | undefined,
): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly details: Record<string, unknown>;
    }
> {
  const cwd = state.cwd;
  if (!cwd) {
    return {
      ok: false,
      code: "story_commit_missing_cwd",
      message: "Cannot commit reviewed story because the TrailStep workflow cwd is unavailable.",
      details: { storyPath: activeStory.path },
    };
  }

  const insideWorkTree = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!insideWorkTree.ok || insideWorkTree.stdout !== "true") {
    return {
      ok: false,
      code: "story_commit_not_git_worktree",
      message:
        "Cannot commit reviewed story because the workflow is not running inside a git worktree.",
      details: {
        storyPath: activeStory.path,
        gitError: insideWorkTree.ok ? undefined : insideWorkTree.error,
      },
    };
  }

  const add = await runGit(["add", "-A"], cwd);
  if (!add.ok) {
    return {
      ok: false,
      code: "story_commit_stage_failed",
      message: "Cannot commit reviewed story because `git add -A` failed.",
      details: { storyPath: activeStory.path, gitError: add.error },
    };
  }

  const staged = await runGit(["diff", "--cached", "--name-only"], cwd);
  if (!staged.ok) {
    return {
      ok: false,
      code: "story_commit_status_failed",
      message: "Cannot commit reviewed story because staged changes could not be inspected.",
      details: { storyPath: activeStory.path, gitError: staged.error },
    };
  }

  if (staged.stdout.trim().length === 0) {
    const baseline = await state.get<ActiveStoryStartCommit | null>(
      STORY_STATE_KEYS.activeStoryStartCommit,
    );
    const head = await runGit(["rev-parse", "HEAD"], cwd);
    if (baseline?.commit && head.ok && head.stdout !== baseline.commit) {
      return { ok: true };
    }

    return {
      ok: false,
      code: "story_commit_empty",
      message:
        "The story passed review, but there are no staged or already-committed changes since the story baseline to commit.",
      details: {
        storyPath: activeStory.path,
        storyStartCommit: baseline?.commit,
        head: head.ok ? head.stdout : undefined,
        gitError: head.ok ? undefined : head.error,
      },
    };
  }

  const storyTitle = extractStoryTitle(activeStory.content, 1);
  const commit = await runGit(
    [
      "commit",
      "-m",
      truncateCommitSubject(`trailstep: ${storyTitle}`),
      "-m",
      commitBody(activeStory, implementationSummary, staged.stdout),
    ],
    cwd,
  );

  if (!commit.ok) {
    return {
      ok: false,
      code: "story_commit_failed",
      message: "The story passed review, but TrailStep could not create the story commit.",
      details: { storyPath: activeStory.path, gitError: commit.error },
    };
  }

  return { ok: true };
}

async function completeReviewedStory(activeStory: Document): Promise<ContinuationResult> {
  const completed = (await state.get<string[]>(STORY_STATE_KEYS.completedStories)) ?? [];
  const updatedCompleted = [
    ...completed,
    extractStoryTitle(activeStory.content, completed.length + 1),
  ];
  await state.set(STORY_STATE_KEYS.completedStories, updatedCompleted);

  const storyQueue = (await state.get<Document[]>(STORY_STATE_KEYS.storyQueue)) ?? [];
  const [nextStory, ...remaining] = storyQueue;

  if (!nextStory) {
    await state.set(STORY_STATE_KEYS.activeStory, null);
    await state.set(STORY_STATE_KEYS.activeStoryContext, null);
    await state.set(STORY_STATE_KEYS.storyContextQueue, []);
    await resetActiveStoryStartCommit();
    const featureDoc = await state.get<Document>("featureDoc");
    const implementationDoc = await state.get<Document>("implementationDoc");
    const output: TakeItAwayOutput = {
      status: "implemented",
      featureDocPath: featureDoc?.path ?? "",
      implementationDocPath: implementationDoc?.path ?? "",
      storyCount: updatedCompleted.length,
      completedStories: updatedCompleted,
      summary: `Implemented and reviewed ${updatedCompleted.length} ${updatedCompleted.length === 1 ? "story" : "stories"}.`,
    };
    return done(output);
  }

  if (!storyAutoCommitEnabled()) {
    const cleanBoundary = await verifyCleanBoundaryBeforeNextStory(activeStory);
    if (!cleanBoundary.ok) {
      return fail({
        code: cleanBoundary.code,
        message: cleanBoundary.message,
        details: cleanBoundary.details,
      });
    }
  }

  const [nextStoryContext = "", ...remainingStoryContexts] =
    (await state.get<string[]>(STORY_STATE_KEYS.storyContextQueue)) ?? [];
  await state.set(STORY_STATE_KEYS.storyQueue, remaining);
  await state.set(STORY_STATE_KEYS.storyContextQueue, remainingStoryContexts);
  await state.set(STORY_STATE_KEYS.activeStory, nextStory);
  await state.set(STORY_STATE_KEYS.activeStoryContext, nextStoryContext);
  await state.set(STORY_STATE_KEYS.storyBaseline, null);
  await resetActiveStoryStartCommit();
  const { storyRouterStep } = await import("../story-router/step.js");
  return storyRouterStep({ reason: "story-completed", currentStory: nextStory });
}

async function verifyCleanBoundaryBeforeNextStory(activeStory: Document): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly details: Record<string, unknown>;
    }
> {
  const cwd = state.cwd;
  if (!cwd) {
    return {
      ok: false,
      code: "story_boundary_missing_cwd",
      message:
        "Cannot advance to the next story because the workflow cwd is unavailable. Commit or restore a clean story boundary from a valid checkout, then retry.",
      details: { storyPath: activeStory.path },
    };
  }

  const status = await runGit(["status", "--short"], cwd);
  if (!status.ok) {
    return {
      ok: false,
      code: "story_boundary_status_failed",
      message:
        "Cannot advance to the next story because TrailStep could not inspect `git status --short`. Fix git status inspection, commit or restore a clean story boundary, then retry.",
      details: { storyPath: activeStory.path, cwd, gitError: status.error },
    };
  }

  if (status.stdout.trim().length > 0) {
    return {
      ok: false,
      code: "story_boundary_dirty_without_auto_commit",
      message:
        "Cannot advance to the next story because auto-commit is disabled and the reviewed story left uncommitted changes. Commit, stash, or otherwise restore a clean story boundary, then retry the workflow.",
      details: { storyPath: activeStory.path, cwd, statusShort: status.stdout },
    };
  }

  return { ok: true };
}

function truncateCommitSubject(subject: string): string {
  return subject.length <= 72 ? subject : `${subject.slice(0, 69)}...`;
}

function commitBody(
  activeStory: Document,
  implementationSummary: string | undefined,
  stagedFiles: string,
): string {
  return [
    "Committed automatically by TrailStep after a passing story review.",
    "",
    `Story artifact: ${activeStory.path}`,
    "",
    "Implementer summary:",
    implementationSummary?.trim() || "Not provided.",
    "",
    "Staged files:",
    stagedFiles
      .split("\n")
      .filter((file) => file.length > 0)
      .map((file) => `- ${file}`)
      .join("\n"),
  ].join("\n");
}
