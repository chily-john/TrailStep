import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { state } from "@stepkit/authoring";

const execFileAsync = promisify(execFile);

export const STORY_STATE_KEYS = {
  activeStory: "activeStory",
  activeStoryStartCommit: "activeStoryStartCommit",
  completedStories: "completedStories",
  storyQueue: "storyQueue",
} as const;

export interface ActiveStoryStartCommit {
  readonly commit?: string;
  readonly warning?: string;
}

export interface StoryReviewGitContext {
  readonly storyStartCommit?: string;
  readonly statusShort?: string;
  readonly committedDiff?: string;
  readonly uncommittedDiff?: string;
  readonly warnings: readonly string[];
}

async function runGit(
  args: readonly string[],
  cwd: string,
): Promise<
  { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly error: string }
> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      maxBuffer: 1024 * 1024 * 10,
    });
    return { ok: true, stdout: stdout.trimEnd() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export async function recordActiveStoryStartCommit(): Promise<ActiveStoryStartCommit> {
  const existing = await state.get<ActiveStoryStartCommit | null>(
    STORY_STATE_KEYS.activeStoryStartCommit,
  );
  if (existing?.commit || existing?.warning) {
    return existing;
  }

  const cwd = state.cwd;
  if (!cwd) {
    const missingCwd = {
      warning:
        "Workflow cwd is unavailable; the story reviewer cannot verify committed story changes from a durable git baseline.",
    };
    await state.set(STORY_STATE_KEYS.activeStoryStartCommit, missingCwd);
    return missingCwd;
  }

  const result = await runGit(["rev-parse", "HEAD"], cwd);
  if (!result.ok || result.stdout.length === 0) {
    const missingGitBaseline = {
      warning: `Unable to record story start commit with \`git rev-parse HEAD\`: ${result.ok ? "no commit was returned" : result.error}`,
    };
    await state.set(STORY_STATE_KEYS.activeStoryStartCommit, missingGitBaseline);
    return missingGitBaseline;
  }

  const baseline = { commit: result.stdout };
  await state.set(STORY_STATE_KEYS.activeStoryStartCommit, baseline);
  return baseline;
}

export async function resetActiveStoryStartCommit(): Promise<void> {
  await state.set(STORY_STATE_KEYS.activeStoryStartCommit, null);
}

export async function loadStoryReviewGitContext(): Promise<StoryReviewGitContext> {
  const baseline = await state.get<ActiveStoryStartCommit | null>(
    STORY_STATE_KEYS.activeStoryStartCommit,
  );
  const warnings: string[] = [];

  if (baseline?.warning) {
    warnings.push(baseline.warning);
  }

  const cwd = state.cwd;
  if (!cwd) {
    warnings.push(
      "Workflow cwd is unavailable; reviewer must treat committed story-change context as missing.",
    );
    return { storyStartCommit: baseline?.commit, warnings };
  }

  const status = await runGit(["status", "--short"], cwd);
  if (!status.ok) {
    warnings.push(`Unable to inspect \`git status --short\`: ${status.error}`);
  }

  const uncommittedDiff = await runGit(["diff"], cwd);
  if (!uncommittedDiff.ok) {
    warnings.push(
      `Unable to inspect uncommitted changes with \`git diff\`: ${uncommittedDiff.error}`,
    );
  }

  const storyStartCommit = baseline?.commit;
  let committedDiff: string | undefined;
  if (!storyStartCommit) {
    warnings.push(
      "No durable story start commit is recorded; reviewer must not silently review only the current working tree diff.",
    );
  } else {
    const baselineReachable = await runGit(["cat-file", "-e", `${storyStartCommit}^{commit}`], cwd);
    if (!baselineReachable.ok) {
      warnings.push(
        `Recorded story start commit \`${storyStartCommit}\` is invalid or unreachable: ${baselineReachable.error}`,
      );
    } else {
      const committed = await runGit(["diff", `${storyStartCommit}..HEAD`], cwd);
      if (!committed.ok) {
        warnings.push(
          `Unable to inspect committed story changes with \`git diff ${storyStartCommit}..HEAD\`: ${committed.error}`,
        );
      } else {
        committedDiff = committed.stdout;
      }
    }
  }

  return {
    storyStartCommit,
    statusShort: status.ok ? status.stdout : undefined,
    committedDiff,
    uncommittedDiff: uncommittedDiff.ok ? uncommittedDiff.stdout : undefined,
    warnings,
  };
}
