import { type Document, state } from "@trailstep/authoring";
import { runGit } from "../commit-reviewed-story/run-git.js";

export const STORY_STATE_KEYS = {
  activePhase: "activePhase",
  activeStory: "activeStory",
  activeStoryContext: "activeStoryContext",
  activeStoryStartCommit: "activeStoryStartCommit",
  attemptsByPhase: "attemptsByPhase",
  completedStories: "completedStories",
  blockedReason: "blockedReason",
  latestExplorationBrief: "latestExplorationBrief",
  latestImplementationSummary: "latestImplementationSummary",
  latestPreflightStatus: "latestPreflightStatus",
  latestRedTestSummary: "latestRedTestSummary",
  latestReviewResult: "latestReviewResult",
  latestStoryRouterState: "latestStoryRouterState",
  latestValidationSummary: "latestValidationSummary",
  storyBaseline: "storyBaseline",
  storyContextQueue: "storyContextQueue",
  storyQueue: "storyQueue",
} as const;

export type StoryPhase =
  | "story-router"
  | "story-isolation-preflight"
  | "explore-story"
  | "write-red-tests"
  | "implement-green"
  | "story-doctor"
  | "validate-story"
  | "implement-story"
  | "review-story-implementation"
  | "commit-reviewed-story";

export type BlockedStoryPhase =
  | "explore-story"
  | "write-red-tests"
  | "implement-green"
  | "validate-story";

export type BlockedStoryRouteSourceReason =
  | "failed-exploration"
  | "failed-red-tests"
  | "failed-implementation"
  | "failed-validation";

export type StoryRouterRoute = "blocked" | "retrying" | "doctoring" | "exhausted";

export interface StoryRouterState {
  readonly route: StoryRouterRoute;
  readonly activeStory: Document;
  readonly targetPhase?: StoryPhase;
  readonly reviewRetryCount: number;
  readonly validationRetryCount: number;
  readonly retryLimit?: number;
  readonly blockedPhase?: BlockedStoryPhase;
  readonly blockedReason?: string;
  readonly exhaustedReason?: "review" | "validation";
  readonly latestReview?: {
    readonly score: number;
    readonly summary: string;
    readonly requiredImprovements: readonly string[];
  };
  readonly latestValidation?: {
    readonly summary: string;
    readonly commands: readonly { readonly command: string; readonly result: string }[];
  };
  readonly source: {
    readonly reason: BlockedStoryRouteSourceReason | "failed-review" | "failed-validation";
    readonly blocked?: true;
    readonly code: string;
    readonly metadata?: Record<string, unknown>;
  };
}

export interface StoryPreflightStatus {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
  readonly baseline?: string;
}

export interface ActiveStoryStartCommit {
  readonly commit?: string;
  readonly warning?: string;
}

export interface StoryReviewGitContext {
  readonly storyStartCommit?: string;
  readonly statusShort?: string;
  readonly changedFiles: readonly string[];
  readonly committedChangedFiles: readonly string[];
  readonly uncommittedChangedFiles: readonly string[];
  readonly committedDiffStat?: string;
  readonly uncommittedDiffStat?: string;
  readonly warnings: readonly string[];
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
  await state.set(STORY_STATE_KEYS.storyBaseline, result.stdout);
  return baseline;
}

export async function incrementStoryPhaseAttempt(phase: StoryPhase): Promise<number> {
  const attempts =
    (await state.get<Record<string, number> | null>(STORY_STATE_KEYS.attemptsByPhase)) ?? {};
  const nextAttempt = (attempts[phase] ?? 0) + 1;
  await state.set(STORY_STATE_KEYS.attemptsByPhase, { ...attempts, [phase]: nextAttempt });
  return nextAttempt;
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
    return {
      storyStartCommit: baseline?.commit,
      changedFiles: [],
      committedChangedFiles: [],
      uncommittedChangedFiles: [],
      warnings,
    };
  }

  const status = await runGit(["status", "--short"], cwd);
  if (!status.ok) {
    warnings.push(`Unable to inspect \`git status --short\`: ${status.error}`);
  }

  const uncommittedChangedFilesResult = await runGit(["diff", "--name-only"], cwd);
  if (!uncommittedChangedFilesResult.ok) {
    warnings.push(
      `Unable to inspect uncommitted changed files with \`git diff --name-only\`: ${uncommittedChangedFilesResult.error}`,
    );
  }

  const uncommittedDiffStatResult = await runGit(["diff", "--stat"], cwd);
  if (!uncommittedDiffStatResult.ok) {
    warnings.push(
      `Unable to inspect uncommitted diffstat with \`git diff --stat\`: ${uncommittedDiffStatResult.error}`,
    );
  }

  const storyStartCommit = baseline?.commit;
  let committedChangedFiles: readonly string[] = [];
  let committedDiffStat: string | undefined;
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
      const committedChangedFilesResult = await runGit(
        ["diff", "--name-only", `${storyStartCommit}..HEAD`],
        cwd,
      );
      if (!committedChangedFilesResult.ok) {
        warnings.push(
          `Unable to inspect committed changed files with \`git diff --name-only ${storyStartCommit}..HEAD\`: ${committedChangedFilesResult.error}`,
        );
      } else {
        committedChangedFiles = splitGitLines(committedChangedFilesResult.stdout);
      }

      const committedDiffStatResult = await runGit(
        ["diff", "--stat", `${storyStartCommit}..HEAD`],
        cwd,
      );
      if (!committedDiffStatResult.ok) {
        warnings.push(
          `Unable to inspect committed diffstat with \`git diff --stat ${storyStartCommit}..HEAD\`: ${committedDiffStatResult.error}`,
        );
      } else {
        committedDiffStat = committedDiffStatResult.stdout;
      }
    }
  }

  const uncommittedTrackedFiles = uncommittedChangedFilesResult.ok
    ? splitGitLines(uncommittedChangedFilesResult.stdout)
    : [];
  const uncommittedStatusFiles = status.ok ? parseStatusChangedFiles(status.stdout) : [];
  const uncommittedChangedFiles = uniqueFiles([
    ...uncommittedTrackedFiles,
    ...uncommittedStatusFiles,
  ]);

  return {
    storyStartCommit,
    statusShort: status.ok ? status.stdout : undefined,
    changedFiles: uniqueFiles([...committedChangedFiles, ...uncommittedChangedFiles]),
    committedChangedFiles,
    uncommittedChangedFiles,
    committedDiffStat,
    uncommittedDiffStat: uncommittedDiffStatResult.ok
      ? uncommittedDiffStatResult.stdout
      : undefined,
    warnings,
  };
}

function splitGitLines(stdout: string): readonly string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseStatusChangedFiles(stdout: string): readonly string[] {
  return splitGitLines(stdout).flatMap((line) => {
    const path = line.slice(3).trim();
    if (path.length === 0) {
      return [];
    }

    const renamedPath = path.split(" -> ").at(-1)?.trim();
    return renamedPath ? [renamedPath] : [];
  });
}

function uniqueFiles(files: readonly string[]): readonly string[] {
  return Array.from(new Set(files));
}
