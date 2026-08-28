import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { runWorkflow } from "@trailstep/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFeatureDocStep } from "../feature-implementation/create-feature-doc/step.js";
import {
  MAX_STORY_REVIEW_ATTEMPTS,
  MAX_STORY_VALIDATION_ATTEMPTS,
  STORY_DOCTOR_VALIDATION_FAILURE_THRESHOLD,
} from "../feature-implementation/shared/constants.js";
import { takeItAway } from "./workflow.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout.trimEnd();
}

async function handleNonGreenStoryPhase(request: {
  readonly outputFile: string;
}): Promise<{ readonly exitCode: number } | undefined> {
  if (request.outputFile.includes("explore-story")) {
    await writeFile(
      request.outputFile,
      JSON.stringify({
        blocked: false,
        summary: "Explored the active story.",
        relevantFiles: ["widget.txt"],
        testSeams: ["widget behavior"],
        recommendedValidationCommands: ["pnpm --filter @trailstep/create-flows test"],
      }),
      "utf8",
    );
    return { exitCode: 0 };
  }

  if (request.outputFile.includes("write-red-tests")) {
    await writeFile(
      request.outputFile,
      JSON.stringify({
        blocked: false,
        summary: "Wrote a focused behavioral red test.",
        redEvidence: "Focused test failed for the intended behavior.",
        changedFiles: ["widget.test.ts"],
      }),
      "utf8",
    );
    return { exitCode: 0 };
  }

  if (request.outputFile.includes("validate-story")) {
    await writeFile(
      request.outputFile,
      JSON.stringify({
        blocked: false,
        summary: "Focused validation passed.",
        commands: [{ command: "pnpm --filter @trailstep/create-flows test", result: "passed" }],
        validationPassed: true,
      }),
      "utf8",
    );
    return { exitCode: 0 };
  }

  return undefined;
}

let previousStoryCommitMode: string | undefined;

beforeEach(() => {
  previousStoryCommitMode = process.env.TRAILSTEP_STORY_COMMIT_MODE;
  delete process.env.TRAILSTEP_STORY_COMMIT_MODE;
});

afterEach(() => {
  if (previousStoryCommitMode === undefined) {
    delete process.env.TRAILSTEP_STORY_COMMIT_MODE;
    return;
  }

  process.env.TRAILSTEP_STORY_COMMIT_MODE = previousStoryCommitMode;
});

describe("take-it-away", () => {
  it("keeps the selected story durably active when implementation is interrupted before review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-interrupted-story-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "Overview of the widget exporter plan.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 002: Add exporter observability",
              "",
              "Emit observable exporter events.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("implement-green")) {
          return { exitCode: 1 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("failure");

    const state = JSON.parse(await readFile(join(result.runDir, "state.json"), "utf8")) as {
      activeStory?: { content?: string } | null;
      completedStories?: string[];
      storyQueue?: Array<{ content?: string }>;
    };

    expect(state.activeStory?.content).toContain("Story 001");
    expect(state.completedStories).toEqual([]);
    expect(state.storyQueue).toHaveLength(1);
    expect(state.storyQueue?.[0]?.content).toContain("Story 002");
  });

  it("fails before implementation prompt when story baseline cannot be recorded", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };

    const blockedImplementationSteps = [
      "explore-story",
      "write-red-tests",
      "implement-green",
      "validate-story",
      "implement-story",
      "review-story-implementation",
    ];
    const requestedOutputFiles: string[] = [];

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-missing-baseline-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }
        requestedOutputFiles.push(request.outputFile);
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected missing git baseline to fail the workflow.");
    }
    expect(result.failure.code).toBe("story_preflight_not_git_worktree");
    expect(result.failure.message).toContain("valid git worktree");
    for (const stepName of blockedImplementationSteps) {
      expect(requestedOutputFiles.some((outputFile) => outputFile.includes(stepName))).toBe(false);
    }
  });

  it("router records active story phase and baseline before dispatching implementation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);
    const baseline = await git(cwd, ["rev-parse", "HEAD"]);

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };

    const implementRequests: string[] = [];

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-router-baseline-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("implement-green")) {
          implementRequests.push(request.outputFile);
          return { exitCode: 1 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("failure");
    expect(implementRequests).toHaveLength(1);

    const persistedState = JSON.parse(
      await readFile(join(result.runDir, "state.json"), "utf8"),
    ) as {
      activePhase?: string;
      activeStory?: { content?: string } | null;
      attemptsByPhase?: Record<string, number>;
      latestPreflightStatus?: { ok?: boolean; baseline?: string; code?: string } | null;
      storyBaseline?: string | null;
    };

    expect(persistedState.activeStory?.content).toContain("Story 001");
    expect(persistedState.activePhase).toBe("implement-green");
    expect(persistedState.storyBaseline).toBe(baseline);
    expect(persistedState.latestPreflightStatus).toEqual({
      ok: true,
      code: "story_preflight_passed",
      message: "Story isolation preflight passed.",
      baseline,
    });
    expect(persistedState.attemptsByPhase?.["story-router"]).toBe(1);
    expect(persistedState.attemptsByPhase?.["story-isolation-preflight"]).toBe(1);
    expect(persistedState.attemptsByPhase?.["explore-story"]).toBe(1);
    expect(persistedState.attemptsByPhase?.["write-red-tests"]).toBe(1);
    expect(persistedState.attemptsByPhase?.["implement-green"]).toBe(1);
  });

  it("runs one story through durable explore red green validate and review phases", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };
    const storyPhaseRequests: string[] = [];

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-split-story-phases-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        for (const phase of [
          "explore-story",
          "write-red-tests",
          "implement-green",
          "validate-story",
          "review-story-implementation",
        ]) {
          if (request.outputFile.includes(phase)) {
            storyPhaseRequests.push(phase);
          }
        }

        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }

        if (request.outputFile.includes("implement-green")) {
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Implemented the green story slice.",
              changedFiles: ["widget.ts"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-story-implementation")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("success");
    expect(storyPhaseRequests).toEqual([
      "explore-story",
      "write-red-tests",
      "implement-green",
      "validate-story",
      "review-story-implementation",
    ]);
    expect(storyPhaseRequests).not.toContain("implement-story");

    const state = JSON.parse(await readFile(join(result.runDir, "state.json"), "utf8")) as {
      latestExplorationBrief?: { summary?: string };
      latestRedTestSummary?: { summary?: string; redEvidence?: string };
      latestImplementationSummary?: { summary?: string };
      latestValidationSummary?: { summary?: string; validationPassed?: boolean };
    };
    expect(state.latestExplorationBrief?.summary).toBe("Explored the active story.");
    expect(state.latestRedTestSummary?.redEvidence).toContain("Focused");
    expect(state.latestImplementationSummary?.summary).toBe("Implemented the green story slice.");
    expect(state.latestValidationSummary?.validationPassed).toBe(true);
  });

  it("routes a failed story review through the story router before retrying the same story", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };
    const requiredImprovement = "Add behavioral red-test evidence before changing implementation.";
    const failingReview = {
      score: 3,
      summary: "Review failed because the red-test evidence is missing.",
      methodologyRatings: {
        tdd: 2,
        verticalSlicing: 4,
        tracerBullet: 4,
        dependencies: 4,
        architecture: 4,
      },
      requiredImprovements: [requiredImprovement],
    };
    const implementGreenPrompts: string[] = [];
    let implementGreenAttempts = 0;

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-failed-story-review-router-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 002: Add exporter observability",
              "",
              "Emit observable exporter events.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }

        if (request.outputFile.includes("implement-green")) {
          implementGreenAttempts += 1;
          implementGreenPrompts.push(await readFile(request.promptFile, "utf8"));
          if (implementGreenAttempts === 1) {
            await writeFile(
              join(cwd, "widget.txt"),
              "Story 001 implementation attempt 1\n",
              "utf8",
            );
            await writeFile(
              request.outputFile,
              JSON.stringify({
                blocked: false,
                summary: "Implemented the first green story slice.",
                changedFiles: ["widget.txt"],
              }),
              "utf8",
            );
            return { exitCode: 0 };
          }

          return { exitCode: 1 };
        }

        if (request.outputFile.includes("review-story-implementation")) {
          await writeFile(request.outputFile, JSON.stringify(failingReview), "utf8");
          return { exitCode: 0 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("failure");
    expect(implementGreenPrompts).toHaveLength(2);
    const retryPrompt = implementGreenPrompts.at(1) ?? "";
    expect(retryPrompt).toContain("Story 001: Build the widget exporter core");
    expect(retryPrompt).toContain(failingReview.summary);
    expect(retryPrompt).toContain(requiredImprovement);
    expect(retryPrompt).not.toContain("Story 002: Add exporter observability");

    const startedStepIds = result.events
      .filter((event) => event.type === "step.started")
      .map((event) => event.stepId);
    const reviewStartedIndex = startedStepIds.indexOf("review-story-implementation");
    const retryImplementStartedIndex = startedStepIds.findIndex(
      (stepId, index) => stepId === "implement-green" && index > reviewStartedIndex,
    );
    const retryRouterStartedIndex = startedStepIds.findIndex(
      (stepId, index) => stepId === "story-router" && index > reviewStartedIndex,
    );

    expect(reviewStartedIndex).toBeGreaterThanOrEqual(0);
    expect(retryImplementStartedIndex).toBeGreaterThan(reviewStartedIndex);
    expect(retryRouterStartedIndex).toBeGreaterThan(reviewStartedIndex);
    expect(retryRouterStartedIndex).toBeLessThan(retryImplementStartedIndex);

    const state = JSON.parse(await readFile(join(result.runDir, "state.json"), "utf8")) as {
      activePhase?: string;
      activeStory?: { content?: string } | null;
      attemptsByPhase?: Record<string, number>;
      completedStories?: string[];
      latestReviewResult?: { score?: number; summary?: string; requiredImprovements?: string[] };
      latestStoryRouterState?: {
        route?: string;
        reviewRetryCount?: number;
        validationRetryCount?: number;
        targetPhase?: string;
        source?: { reason?: string };
      } | null;
      storyQueue?: Array<{ content?: string }>;
    };
    expect(state.activePhase).toBe("implement-green");
    expect(state.activeStory?.content).toContain("Story 001");
    expect(state.completedStories).toEqual([]);
    expect(state.storyQueue).toHaveLength(1);
    expect(state.storyQueue?.[0]?.content).toContain("Story 002");
    expect(state.latestReviewResult).toMatchObject({
      score: 3,
      summary: failingReview.summary,
      requiredImprovements: [requiredImprovement],
    });
    expect(state.latestStoryRouterState).toMatchObject({
      route: "retrying",
      reviewRetryCount: 1,
      validationRetryCount: 0,
      targetPhase: "implement-green",
      source: { reason: "failed-review" },
    });
    expect(state.attemptsByPhase?.["story-router"]).toBe(2);
    expect(state.attemptsByPhase?.["implement-green"]).toBe(2);
    expect(state.attemptsByPhase?.["review-story-implementation"]).toBe(1);
  });

  it("starts the next story with clean story-local state and retry budgets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    const runName = "take-it-away-clean-next-story-state-run";
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);
    const initialBaseline = await git(cwd, ["rev-parse", "HEAD"]);
    process.env.TRAILSTEP_STORY_COMMIT_MODE = "enabled";

    const storyOneExplorationToken = "STORY_001_EXPLORATION_TOKEN";
    const storyOneRedToken = "STORY_001_RED_TOKEN";
    const storyOneImplementationToken = "STORY_001_IMPLEMENTATION_TOKEN";
    const storyOneValidationToken = "STORY_001_VALIDATION_TOKEN";
    const storyOneReviewToken = "STORY_001_REVIEW_TOKEN";
    const storyOneContextToken = "STORY_001_CONTEXT_TOKEN";
    const storyTwoContextToken = "STORY_002_CONTEXT_TOKEN";
    const storyTwoExplorationToken = "STORY_002_EXPLORATION_TOKEN";
    const storyTwoRedToken = "STORY_002_RED_TOKEN";
    const staleStoryOneTokens = [
      storyOneExplorationToken,
      storyOneRedToken,
      storyOneImplementationToken,
      storyOneValidationToken,
      storyOneReviewToken,
    ];

    const passingImplementationDocReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };
    const passingStoryReview = {
      score: 5,
      summary: "Story review passes after the requested fix.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };
    const failingStoryReview = {
      score: 3,
      summary: `${storyOneReviewToken}: story needs one more focused red-test evidence note.`,
      methodologyRatings: {
        tdd: 2,
        verticalSlicing: 4,
        tracerBullet: 4,
        dependencies: 4,
        architecture: 4,
      },
      requiredImprovements: [`Address ${storyOneReviewToken} before passing.`],
    };
    let storyOneImplementAttempts = 0;
    let storyOneReviewAttempts = 0;
    const storyTwoImplementPrompts: string[] = [];

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName,
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "<context>",
              "audience: implementer",
              "stories: Story 001",
              "phases: explore-story",
              "",
              storyOneContextToken,
              "",
              "</context>",
              "",
              "<context>",
              "audience: implementer",
              "stories: Story 002",
              "phases: explore-story",
              "",
              storyTwoContextToken,
              "",
              "</context>",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 002: Add exporter observability",
              "",
              "Emit observable exporter events.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(
            request.outputFile,
            JSON.stringify(passingImplementationDocReview),
            "utf8",
          );
          return { exitCode: 0 };
        }

        const prompt = await readFile(request.promptFile, "utf8");
        const storyLabel = prompt.includes("Story 002: Add exporter observability")
          ? "Story 002"
          : "Story 001";

        if (request.outputFile.includes("explore-story")) {
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary:
                storyLabel === "Story 001" ? storyOneExplorationToken : storyTwoExplorationToken,
              relevantFiles: ["widget.txt"],
              testSeams: [`${storyLabel} behavior`],
              recommendedValidationCommands: ["pnpm --filter @trailstep/create-flows test"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("write-red-tests")) {
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: storyLabel === "Story 001" ? storyOneRedToken : storyTwoRedToken,
              redEvidence:
                storyLabel === "Story 001"
                  ? `${storyOneRedToken} failed for the intended reason.`
                  : `${storyTwoRedToken} failed for the intended reason.`,
              changedFiles: ["widget.test.ts"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("implement-green")) {
          if (storyLabel === "Story 002") {
            storyTwoImplementPrompts.push(prompt);
            return { exitCode: 1 };
          }

          storyOneImplementAttempts += 1;
          await writeFile(
            join(cwd, "widget.txt"),
            `${storyOneImplementationToken} attempt ${storyOneImplementAttempts}\n`,
            "utf8",
          );
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: `${storyOneImplementationToken} attempt ${storyOneImplementAttempts}`,
              changedFiles: ["widget.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("validate-story")) {
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: storyOneValidationToken,
              commands: [
                { command: "pnpm --filter @trailstep/create-flows test", result: "passed" },
              ],
              validationPassed: true,
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-story-implementation")) {
          if (storyLabel !== "Story 001") {
            throw new Error("Story 002 should stop before review in this test.");
          }

          storyOneReviewAttempts += 1;
          await writeFile(
            request.outputFile,
            JSON.stringify(storyOneReviewAttempts === 1 ? failingStoryReview : passingStoryReview),
            "utf8",
          );
          return { exitCode: 0 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("failure");
    expect(storyOneImplementAttempts).toBe(2);
    expect(storyOneReviewAttempts).toBe(2);
    expect(storyTwoImplementPrompts).toHaveLength(1);
    const storyTwoImplementPrompt = storyTwoImplementPrompts[0] ?? "";
    expect(storyTwoImplementPrompt).toContain("Story 002: Add exporter observability");
    expect(storyTwoImplementPrompt).toContain(storyTwoExplorationToken);
    expect(storyTwoImplementPrompt).toContain(storyTwoRedToken);
    for (const staleToken of [storyOneContextToken, ...staleStoryOneTokens]) {
      expect(storyTwoImplementPrompt).not.toContain(staleToken);
    }

    const storyTwoBaseline = await git(cwd, ["rev-parse", "HEAD"]);
    expect(storyTwoBaseline).not.toBe(initialBaseline);

    const state = JSON.parse(await readFile(join(result.runDir, "state.json"), "utf8")) as {
      activeStory?: { content?: string } | null;
      activeStoryContext?: string | null;
      activeStoryStartCommit?: { commit?: string } | null;
      attemptsByPhase?: Record<string, number>;
      blockedReason?: string | null;
      completedStories?: string[];
      latestExplorationBrief?: { summary?: string } | null;
      latestImplementationSummary?: { summary?: string } | null;
      latestPreflightStatus?: { baseline?: string } | null;
      latestRedTestSummary?: { redEvidence?: string; summary?: string } | null;
      latestReviewResult?: { summary?: string } | null;
      latestStoryRouterState?: unknown | null;
      latestValidationSummary?: { summary?: string } | null;
      storyBaseline?: string | null;
      storyContextQueue?: string[];
      storyQueue?: Array<{ content?: string }>;
    };

    expect(state.activeStory?.content).toContain("Story 002: Add exporter observability");
    expect(state.activeStoryContext).toContain(storyTwoContextToken);
    expect(state.completedStories).toEqual(["Story 001: Build the widget exporter core"]);
    expect(state.storyQueue ?? []).toEqual([]);
    expect(state.storyContextQueue ?? []).toEqual([]);
    expect(state.attemptsByPhase).toEqual({
      "story-router": 1,
      "story-isolation-preflight": 1,
      "explore-story": 1,
      "write-red-tests": 1,
      "implement-green": 1,
    });
    expect(state.latestPreflightStatus?.baseline).toBe(storyTwoBaseline);
    expect(state.storyBaseline).toBe(storyTwoBaseline);
    expect(state.activeStoryStartCommit?.commit).toBe(storyTwoBaseline);
    expect(state.latestExplorationBrief?.summary).toBe(storyTwoExplorationToken);
    expect(state.latestRedTestSummary?.summary).toBe(storyTwoRedToken);
    expect(state.latestRedTestSummary?.redEvidence).toContain(storyTwoRedToken);
    expect(state.latestImplementationSummary ?? null).toBeNull();
    expect(state.latestValidationSummary ?? null).toBeNull();
    expect(state.latestReviewResult ?? null).toBeNull();
    expect(state.latestStoryRouterState ?? null).toBeNull();
    expect(state.blockedReason ?? null).toBeNull();
    for (const staleToken of staleStoryOneTokens) {
      expect(JSON.stringify(state)).not.toContain(staleToken);
    }
  }, 10_000);

  it("manual retry resumes a persisted review retry route without replaying planning or consuming another review retry", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);
    process.env.TRAILSTEP_STORY_COMMIT_MODE = "enabled";

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };
    const requiredImprovement = "Add behavioral red-test evidence before changing implementation.";
    const failingReview = {
      score: 3,
      summary: "Story 002 review failed because the red-test evidence is missing.",
      methodologyRatings: {
        tdd: 2,
        verticalSlicing: 4,
        tracerBullet: 4,
        dependencies: 4,
        architecture: 4,
      },
      requiredImprovements: [requiredImprovement],
    };
    const trailstepConfig = {
      version: 1 as const,
      customProviders: { worker: { binary: "worker-agent" } },
      agents: {
        small: [{ provider: "worker" }],
        medium: [{ provider: "worker" }],
        large: [{ provider: "worker" }],
      },
    };
    let storyOneImplementAttempts = 0;
    let storyTwoImplementAttempts = 0;

    const failed = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-persisted-review-route-run",
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 002: Add exporter observability",
              "",
              "Emit observable exporter events.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }

        if (request.outputFile.includes("implement-green")) {
          const prompt = await readFile(request.promptFile, "utf8");
          const storyLabel = prompt.includes("Story 002: Add exporter observability")
            ? "Story 002"
            : "Story 001";
          if (storyLabel === "Story 002") {
            storyTwoImplementAttempts += 1;
            if (storyTwoImplementAttempts === 2) {
              return { exitCode: 1 };
            }
          } else {
            storyOneImplementAttempts += 1;
          }

          const attempt =
            storyLabel === "Story 002" ? storyTwoImplementAttempts : storyOneImplementAttempts;
          if (storyLabel === "Story 001") {
            await writeFile(
              join(cwd, "widget.txt"),
              `${storyLabel} implementation attempt ${attempt}\n`,
              "utf8",
            );
          }
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: `${storyLabel} green implementation attempt ${attempt}.`,
              changedFiles: ["widget.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-story-implementation")) {
          const prompt = await readFile(request.promptFile, "utf8");
          await writeFile(
            request.outputFile,
            JSON.stringify(
              prompt.includes("Story 002: Add exporter observability")
                ? failingReview
                : passingReview,
            ),
            "utf8",
          );
          return { exitCode: 0 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(failed.status).toBe("failure");
    const failedState = JSON.parse(await readFile(join(failed.runDir, "state.json"), "utf8")) as {
      activeStory?: { content?: string } | null;
      completedStories?: string[];
      latestStoryRouterState?: {
        route?: string;
        reviewRetryCount?: number;
        targetPhase?: string;
        latestReview?: { summary?: string; requiredImprovements?: string[] };
        activeStory?: { content?: string };
      } | null;
    };
    expect(failedState.activeStory?.content).toContain("Story 002: Add exporter observability");
    expect(failedState.completedStories).toEqual(["Story 001: Build the widget exporter core"]);
    expect(failedState.latestStoryRouterState).toMatchObject({
      route: "retrying",
      targetPhase: "implement-green",
      reviewRetryCount: 1,
      activeStory: { content: expect.stringContaining("Story 002: Add exporter observability") },
      latestReview: {
        summary: failingReview.summary,
        requiredImprovements: [requiredImprovement],
      },
    });

    const retryAgentRequests: string[] = [];
    const retryAgentPrompts: string[] = [];
    const planningStepNames = [
      "create-feature-doc",
      "create-or-improve-implementation-doc",
      "review-implementation-doc",
      "split-implementation-stories",
    ];
    const retried = await runWorkflow({
      workflow: takeItAway,
      retry: { runDir: failed.runDir, kind: "manual" },
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        retryAgentRequests.push(request.outputFile);
        const planningStepName = planningStepNames.find((stepName) =>
          request.outputFile.includes(stepName),
        );
        if (planningStepName) {
          throw new Error(`Retry unexpectedly dispatched planning step ${planningStepName}.`);
        }

        if (request.outputFile.includes("implement-green")) {
          retryAgentPrompts.push(await readFile(request.promptFile, "utf8"));
          return { exitCode: 1 };
        }

        throw new Error(`Unexpected retry working-agent request: ${request.outputFile}`);
      },
    });

    expect(retried.status).toBe("failure");
    expect(retryAgentRequests[0]).toContain("implement-green");
    const retryPrompt = retryAgentPrompts[0] ?? "";
    expect(retryPrompt).toContain("Story 002: Add exporter observability");
    expect(retryPrompt).toContain(failingReview.summary);
    expect(retryPrompt).not.toContain("Story 001: Build the widget exporter core");

    const retriedState = JSON.parse(await readFile(join(failed.runDir, "state.json"), "utf8")) as {
      latestStoryRouterState?: { reviewRetryCount?: number } | null;
    };
    expect(retriedState.latestStoryRouterState?.reviewRetryCount).toBe(1);
  }, 10_000);

  it("manual retry resumes a persisted doctor route at story-doctor without exhausting during replay", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };
    const failedValidationSummary = "Focused validation still fails after implementation work.";
    const failedValidationResult = "failed: widget output omitted stable metadata";
    const trailstepConfig = {
      version: 1 as const,
      customProviders: { worker: { binary: "worker-agent" } },
      agents: {
        small: [{ provider: "worker" }],
        medium: [{ provider: "worker" }],
        large: [{ provider: "worker" }],
      },
    };
    let implementGreenAttempts = 0;
    let validateAttempts = 0;
    let doctorAttempts = 0;

    const failed = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-persisted-doctor-route-run",
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult && !request.outputFile.includes("validate-story")) {
          return splitPhaseResult;
        }

        if (request.outputFile.includes("implement-green")) {
          implementGreenAttempts += 1;
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: `Implemented green story slice attempt ${implementGreenAttempts}.`,
              changedFiles: ["widget.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("validate-story")) {
          validateAttempts += 1;
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: `${failedValidationSummary} Attempt ${validateAttempts}.`,
              commands: [
                {
                  command: "pnpm --filter @trailstep/create-flows test -- take-it-away",
                  result: failedValidationResult,
                },
              ],
              validationPassed: false,
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("story-doctor")) {
          doctorAttempts += 1;
          return { exitCode: 1 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(failed.status).toBe("failure");
    expect(doctorAttempts).toBe(1);
    const failedState = JSON.parse(await readFile(join(failed.runDir, "state.json"), "utf8")) as {
      latestStoryRouterState?: {
        route?: string;
        targetPhase?: string;
        validationRetryCount?: number;
      } | null;
    };
    expect(failedState.latestStoryRouterState).toMatchObject({
      route: "doctoring",
      targetPhase: "story-doctor",
      validationRetryCount: STORY_DOCTOR_VALIDATION_FAILURE_THRESHOLD,
    });

    const retryAgentRequests: string[] = [];
    const planningStepNames = [
      "create-feature-doc",
      "create-or-improve-implementation-doc",
      "review-implementation-doc",
      "split-implementation-stories",
    ];
    const retried = await runWorkflow({
      workflow: takeItAway,
      retry: { runDir: failed.runDir, kind: "manual" },
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        retryAgentRequests.push(request.outputFile);
        const planningStepName = planningStepNames.find((stepName) =>
          request.outputFile.includes(stepName),
        );
        if (planningStepName) {
          throw new Error(`Retry unexpectedly dispatched planning step ${planningStepName}.`);
        }

        if (request.outputFile.includes("story-doctor")) {
          return { exitCode: 1 };
        }

        throw new Error(`Unexpected retry working-agent request: ${request.outputFile}`);
      },
    });

    expect(retried.status).toBe("failure");
    expect(retryAgentRequests[0]).toContain("story-doctor");
    const retriedState = JSON.parse(await readFile(join(failed.runDir, "state.json"), "utf8")) as {
      latestStoryRouterState?: { validationRetryCount?: number } | null;
    };
    expect(retriedState.latestStoryRouterState?.validationRetryCount).toBe(
      STORY_DOCTOR_VALIDATION_FAILURE_THRESHOLD,
    );
  });

  it("manual retry fails explicitly when durable retry router state belongs to a different active story", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };
    const failingReview = {
      score: 3,
      summary: "Review failed because the red-test evidence is missing.",
      methodologyRatings: {
        tdd: 2,
        verticalSlicing: 4,
        tracerBullet: 4,
        dependencies: 4,
        architecture: 4,
      },
      requiredImprovements: ["Add behavioral red-test evidence before changing implementation."],
    };
    const trailstepConfig = {
      version: 1 as const,
      customProviders: { worker: { binary: "worker-agent" } },
      agents: {
        small: [{ provider: "worker" }],
        medium: [{ provider: "worker" }],
        large: [{ provider: "worker" }],
      },
    };
    let implementGreenAttempts = 0;

    const failed = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-mismatched-router-state-run",
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }

        if (request.outputFile.includes("implement-green")) {
          implementGreenAttempts += 1;
          if (implementGreenAttempts === 2) {
            return { exitCode: 1 };
          }
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Implemented the green story slice.",
              changedFiles: ["widget.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-story-implementation")) {
          await writeFile(request.outputFile, JSON.stringify(failingReview), "utf8");
          return { exitCode: 0 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(failed.status).toBe("failure");
    const statePath = join(failed.runDir, "state.json");
    const failedState = JSON.parse(await readFile(statePath, "utf8")) as {
      latestStoryRouterState?: { activeStory?: { path?: string; content?: string } } | null;
    };
    expect(failedState.latestStoryRouterState?.activeStory?.content).toContain(
      "Story 001: Build the widget exporter core",
    );
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          ...failedState,
          latestStoryRouterState: {
            ...failedState.latestStoryRouterState,
            activeStory: {
              ...failedState.latestStoryRouterState?.activeStory,
              path: "mismatched-story.md",
              content: "## Story 999: Mismatched durable story\n\nThis is not the active story.",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const retryAgentRequests: string[] = [];
    const retried = await runWorkflow({
      workflow: takeItAway,
      retry: { runDir: failed.runDir, kind: "manual" },
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        retryAgentRequests.push(request.outputFile);
        return { exitCode: 1 };
      },
    });

    expect(retried.status).toBe("failure");
    if (retried.status !== "failure") {
      throw new Error("Expected mismatched retry router state to fail.");
    }
    expect(retried.failure.code).toBe("story_router_retry_state_mismatch");
    expect(retryAgentRequests).toEqual([]);
  });

  it("keeps retrying failed story review until the review retry limit is reached", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);
    process.env.TRAILSTEP_STORY_COMMIT_MODE = "enabled";

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };
    const storyOneFailingReview = {
      score: 3,
      summary: "Story 001 review failed before the story eventually passed.",
      methodologyRatings: {
        tdd: 2,
        verticalSlicing: 4,
        tracerBullet: 4,
        dependencies: 4,
        architecture: 4,
      },
      requiredImprovements: ["Add the missing red-test evidence for story 001."],
    };
    const storyTwoReviewSummaries: string[] = [];
    let storyOneImplementAttempts = 0;
    let storyOneReviewAttempts = 0;
    let storyTwoImplementAttempts = 0;
    let storyTwoReviewAttempts = 0;

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-review-retry-cap-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 002: Add exporter observability",
              "",
              "Emit observable exporter events.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult && !request.outputFile.includes("implement-green")) {
          return splitPhaseResult;
        }

        if (request.outputFile.includes("implement-green")) {
          const prompt = await readFile(request.promptFile, "utf8");
          const storyLabel = prompt.includes("Story 002: Add exporter observability")
            ? "Story 002"
            : "Story 001";
          if (storyLabel === "Story 002") {
            storyTwoImplementAttempts += 1;
          } else {
            storyOneImplementAttempts += 1;
          }
          await writeFile(
            join(cwd, "widget.txt"),
            `${storyLabel} implementation attempt ${
              storyLabel === "Story 002" ? storyTwoImplementAttempts : storyOneImplementAttempts
            }\n`,
            "utf8",
          );
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Implemented the green story slice.",
              changedFiles: ["widget.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-story-implementation")) {
          const prompt = await readFile(request.promptFile, "utf8");
          if (prompt.includes("Story 001: Build the widget exporter core")) {
            storyOneReviewAttempts += 1;
            await writeFile(
              request.outputFile,
              JSON.stringify(storyOneReviewAttempts === 1 ? storyOneFailingReview : passingReview),
              "utf8",
            );
            return { exitCode: 0 };
          }

          storyTwoReviewAttempts += 1;
          const summary = `Story 002 review failed attempt ${storyTwoReviewAttempts}.`;
          storyTwoReviewSummaries.push(summary);
          await writeFile(
            request.outputFile,
            JSON.stringify({
              score: 3,
              summary,
              methodologyRatings: {
                tdd: 2,
                verticalSlicing: 4,
                tracerBullet: 4,
                dependencies: 4,
                architecture: 4,
              },
              requiredImprovements: ["Add the missing red-test evidence for story 002."],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected repeated story review failures to exhaust the second story.");
    }
    expect(result.failure.code).toBe("story_review_exhausted");
    expect(storyOneReviewAttempts).toBe(2);
    expect(storyTwoReviewAttempts).toBe(MAX_STORY_REVIEW_ATTEMPTS);
    expect(storyTwoImplementAttempts).toBe(MAX_STORY_REVIEW_ATTEMPTS);
    expect(result.failure.details).toMatchObject({
      storyPath: expect.any(String),
      reviewRetryCount: MAX_STORY_REVIEW_ATTEMPTS,
      retryLimit: MAX_STORY_REVIEW_ATTEMPTS,
      review: {
        summary: storyTwoReviewSummaries.at(-1),
      },
    });

    const state = JSON.parse(await readFile(join(result.runDir, "state.json"), "utf8")) as {
      latestStoryRouterState?: {
        route?: string;
        exhaustedReason?: string;
        reviewRetryCount?: number;
        validationRetryCount?: number;
        retryLimit?: number;
        activeStory?: { content?: string };
        latestReview?: { summary?: string };
        source?: { reason?: string; code?: string };
      } | null;
    };
    expect(state.latestStoryRouterState).toMatchObject({
      route: "exhausted",
      exhaustedReason: "review",
      reviewRetryCount: MAX_STORY_REVIEW_ATTEMPTS,
      validationRetryCount: 0,
      retryLimit: MAX_STORY_REVIEW_ATTEMPTS,
      activeStory: {
        content: expect.stringContaining("Story 002: Add exporter observability"),
      },
      latestReview: {
        summary: storyTwoReviewSummaries.at(-1),
      },
      source: {
        reason: "failed-review",
        code: "story_review_exhausted",
      },
    });
  });

  it("routes failed validation through the story router back to the same story implementation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };
    const failedValidationSummary =
      "Focused validation failed because widget output still misses the red-test assertion.";
    const failedValidationResult = "failed: expected widget export to include stable metadata";
    const passingValidationSummary = "Focused validation passed after fixing the widget exporter.";
    const implementGreenPrompts: string[] = [];
    const reviewPrompts: string[] = [];
    let implementGreenAttempts = 0;
    let validateAttempts = 0;

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-failed-validation-router-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 002: Add exporter observability",
              "",
              "Emit observable exporter events.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("explore-story")) {
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Explored the active story.",
              relevantFiles: ["widget.txt"],
              testSeams: ["widget behavior"],
              recommendedValidationCommands: ["pnpm --filter @trailstep/create-flows test"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("write-red-tests")) {
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Wrote a focused behavioral red test.",
              redEvidence: "Focused test failed for the intended behavior.",
              changedFiles: ["widget.test.ts"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("implement-green")) {
          implementGreenAttempts += 1;
          implementGreenPrompts.push(await readFile(request.promptFile, "utf8"));
          await writeFile(
            join(cwd, "widget.txt"),
            `Story 001 implementation attempt ${implementGreenAttempts}\n`,
            "utf8",
          );
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: `Implemented green story slice attempt ${implementGreenAttempts}.`,
              changedFiles: ["widget.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("validate-story")) {
          validateAttempts += 1;
          if (validateAttempts === 1) {
            await writeFile(
              request.outputFile,
              JSON.stringify({
                blocked: false,
                summary: failedValidationSummary,
                commands: [
                  {
                    command: "pnpm --filter @trailstep/create-flows test -- take-it-away",
                    result: failedValidationResult,
                  },
                ],
                validationPassed: false,
              }),
              "utf8",
            );
            return { exitCode: 0 };
          }

          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: passingValidationSummary,
              commands: [
                {
                  command: "pnpm --filter @trailstep/create-flows test -- take-it-away",
                  result: "passed",
                },
              ],
              validationPassed: true,
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-story-implementation")) {
          reviewPrompts.push(await readFile(request.promptFile, "utf8"));
          return { exitCode: 1 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("failure");
    expect(implementGreenPrompts).toHaveLength(2);
    const retryPrompt = implementGreenPrompts.at(1) ?? "";
    expect(retryPrompt).toContain("Story 001: Build the widget exporter core");
    expect(retryPrompt).toContain(failedValidationSummary);
    expect(retryPrompt).toContain(failedValidationResult);
    expect(retryPrompt).not.toContain("Story 002: Add exporter observability");
    expect(validateAttempts).toBe(2);
    expect(reviewPrompts).toHaveLength(1);

    const failedValidationCompletedIndex = result.events.findIndex(
      (event) => event.type === "step.completed" && event.stepId === "validate-story",
    );
    const retryRouterStartedIndex = result.events.findIndex(
      (event, index) =>
        event.type === "step.started" &&
        event.stepId === "story-router" &&
        index > failedValidationCompletedIndex,
    );
    const retryImplementStartedIndex = result.events.findIndex(
      (event, index) =>
        event.type === "step.started" &&
        event.stepId === "implement-green" &&
        index > retryRouterStartedIndex,
    );
    const passingValidationCompletedIndex = result.events.findIndex(
      (event, index) =>
        event.type === "step.completed" &&
        event.stepId === "validate-story" &&
        index > retryImplementStartedIndex,
    );
    const reviewStartedIndex = result.events.findIndex(
      (event, index) =>
        event.type === "step.started" &&
        event.stepId === "review-story-implementation" &&
        index > passingValidationCompletedIndex,
    );

    expect(failedValidationCompletedIndex).toBeGreaterThanOrEqual(0);
    expect(retryRouterStartedIndex).toBeGreaterThan(failedValidationCompletedIndex);
    expect(retryImplementStartedIndex).toBeGreaterThan(retryRouterStartedIndex);
    expect(passingValidationCompletedIndex).toBeGreaterThan(retryImplementStartedIndex);
    expect(reviewStartedIndex).toBeGreaterThan(passingValidationCompletedIndex);

    const state = JSON.parse(await readFile(join(result.runDir, "state.json"), "utf8")) as {
      activePhase?: string;
      activeStory?: { content?: string } | null;
      attemptsByPhase?: Record<string, number>;
      completedStories?: string[];
      latestValidationSummary?: { summary?: string; validationPassed?: boolean };
      latestStoryRouterState?: {
        route?: string;
        reviewRetryCount?: number;
        validationRetryCount?: number;
        targetPhase?: string;
        source?: { reason?: string };
      } | null;
      storyQueue?: Array<{ content?: string }>;
    };
    expect(state.activePhase).toBe("review-story-implementation");
    expect(state.activeStory?.content).toContain("Story 001");
    expect(state.completedStories).toEqual([]);
    expect(state.storyQueue).toHaveLength(1);
    expect(state.storyQueue?.[0]?.content).toContain("Story 002");
    expect(state.latestValidationSummary).toMatchObject({
      summary: passingValidationSummary,
      validationPassed: true,
    });
    expect(state.latestStoryRouterState).toMatchObject({
      route: "retrying",
      reviewRetryCount: 0,
      validationRetryCount: 1,
      targetPhase: "implement-green",
      source: { reason: "failed-validation" },
    });
    expect(state.attemptsByPhase?.["story-router"]).toBe(2);
    expect(state.attemptsByPhase?.["implement-green"]).toBe(2);
    expect(state.attemptsByPhase?.["validate-story"]).toBe(2);
    expect(state.attemptsByPhase?.["review-story-implementation"]).toBe(1);
  });

  it("escalates repeated validation failures to the story doctor and then exhausts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };
    const failedValidationSummary = "Focused validation still fails after implementation work.";
    const failedValidationResult = "failed: widget output omitted stable metadata";
    const implementGreenPrompts: string[] = [];
    const doctorPrompts: string[] = [];
    let implementGreenAttempts = 0;
    let doctorAttempts = 0;
    let validateAttempts = 0;

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-validation-doctor-exhaustion-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 002: Add exporter observability",
              "",
              "Emit observable exporter events.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult && !request.outputFile.includes("validate-story")) {
          return splitPhaseResult;
        }

        if (request.outputFile.includes("implement-green")) {
          implementGreenAttempts += 1;
          implementGreenPrompts.push(await readFile(request.promptFile, "utf8"));
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: `Implemented green story slice attempt ${implementGreenAttempts}.`,
              changedFiles: ["widget.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("story-doctor")) {
          doctorAttempts += 1;
          doctorPrompts.push(await readFile(request.promptFile, "utf8"));
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Doctor repaired the suspected validation failure root cause.",
              changedFiles: ["widget.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("validate-story")) {
          validateAttempts += 1;
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: `${failedValidationSummary} Attempt ${validateAttempts}.`,
              commands: [
                {
                  command: "pnpm --filter @trailstep/create-flows test -- take-it-away",
                  result: failedValidationResult,
                },
              ],
              validationPassed: false,
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-story-implementation")) {
          throw new Error("Exhausted validation should not dispatch story review.");
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected repeated validation failure to exhaust the story.");
    }
    expect(result.failure.code).toBe("story_validation_exhausted");
    expect(implementGreenPrompts).toHaveLength(2);
    expect(doctorPrompts).toHaveLength(1);
    expect(validateAttempts).toBe(3);
    expect(doctorAttempts).toBe(1);
    expect(doctorPrompts[0]).toContain(failedValidationSummary);
    expect(doctorPrompts[0]).toContain(failedValidationResult);
    expect(doctorPrompts[0]).toContain("Validation failure count consumed by the router: 2/3");

    const doctorStartedIndex = result.events.findIndex(
      (event) => event.type === "step.started" && event.stepId === "story-doctor",
    );
    const reviewStartedAfterDoctorIndex = result.events.findIndex(
      (event, index) =>
        event.type === "step.started" &&
        event.stepId === "review-story-implementation" &&
        index > doctorStartedIndex,
    );
    expect(doctorStartedIndex).toBeGreaterThanOrEqual(0);
    expect(reviewStartedAfterDoctorIndex).toBe(-1);

    const state = JSON.parse(await readFile(join(result.runDir, "state.json"), "utf8")) as {
      activeStory?: { content?: string } | null;
      latestStoryRouterState?: {
        route?: string;
        exhaustedReason?: string;
        reviewRetryCount?: number;
        validationRetryCount?: number;
        retryLimit?: number;
        targetPhase?: string;
      } | null;
    };
    expect(state.activeStory?.content).toContain("Story 001");
    expect(state.latestStoryRouterState).toMatchObject({
      route: "exhausted",
      exhaustedReason: "validation",
      reviewRetryCount: 0,
      validationRetryCount: 3,
      retryLimit: 3,
    });
    expect(state.latestStoryRouterState?.targetPhase).toBeUndefined();
  });

  it("keeps retrying failed story validation until the validation retry limit is reached", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);
    process.env.TRAILSTEP_STORY_COMMIT_MODE = "enabled";

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };
    const storyTwoValidationSummaries: string[] = [];
    const storyTwoValidationResults: string[] = [];
    let storyOneImplementAttempts = 0;
    let storyOneValidationAttempts = 0;
    let storyTwoDoctorAttempts = 0;
    let storyTwoImplementAttempts = 0;
    let storyTwoValidationAttempts = 0;

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-validation-retry-cap-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 002: Add exporter observability",
              "",
              "Emit observable exporter events.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (
          splitPhaseResult &&
          !request.outputFile.includes("implement-green") &&
          !request.outputFile.includes("validate-story")
        ) {
          return splitPhaseResult;
        }

        if (request.outputFile.includes("implement-green")) {
          const prompt = await readFile(request.promptFile, "utf8");
          const storyLabel = prompt.includes("Story 002: Add exporter observability")
            ? "Story 002"
            : "Story 001";
          if (storyLabel === "Story 002") {
            storyTwoImplementAttempts += 1;
          } else {
            storyOneImplementAttempts += 1;
          }
          await writeFile(
            join(cwd, "widget.txt"),
            `${storyLabel} implementation attempt ${
              storyLabel === "Story 002" ? storyTwoImplementAttempts : storyOneImplementAttempts
            }\n`,
            "utf8",
          );
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Implemented the green story slice.",
              changedFiles: ["widget.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("validate-story")) {
          const prompt = await readFile(request.promptFile, "utf8");
          if (prompt.includes("Story 001: Build the widget exporter core")) {
            storyOneValidationAttempts += 1;
            await writeFile(
              request.outputFile,
              JSON.stringify({
                blocked: false,
                summary:
                  storyOneValidationAttempts === 1
                    ? "Story 001 validation failed before the story eventually passed."
                    : "Story 001 validation passed.",
                commands: [
                  {
                    command: "pnpm --filter @trailstep/create-flows test -- take-it-away",
                    result:
                      storyOneValidationAttempts === 1
                        ? "failed: expected Story 001 metadata"
                        : "passed",
                  },
                ],
                validationPassed: storyOneValidationAttempts !== 1,
              }),
              "utf8",
            );
            return { exitCode: 0 };
          }

          storyTwoValidationAttempts += 1;
          const summary = `Story 002 validation failed attempt ${storyTwoValidationAttempts}.`;
          const resultText = `failed: Story 002 validation failure ${storyTwoValidationAttempts}`;
          storyTwoValidationSummaries.push(summary);
          storyTwoValidationResults.push(resultText);
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary,
              commands: [
                {
                  command: "pnpm --filter @trailstep/create-flows test -- take-it-away",
                  result: resultText,
                },
              ],
              validationPassed: false,
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("story-doctor")) {
          const prompt = await readFile(request.promptFile, "utf8");
          if (prompt.includes("Story 002: Add exporter observability")) {
            storyTwoDoctorAttempts += 1;
          }
          await writeFile(
            join(cwd, "widget.txt"),
            `Story 002 doctor attempt ${storyTwoDoctorAttempts}\n`,
            "utf8",
          );
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Doctor repaired the suspected validation failure root cause.",
              changedFiles: ["widget.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-story-implementation")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected repeated story validation failures to exhaust the second story.");
    }
    expect(result.failure.code).toBe("story_validation_exhausted");
    expect(storyOneValidationAttempts).toBe(2);
    expect(storyTwoValidationAttempts).toBe(MAX_STORY_VALIDATION_ATTEMPTS);
    expect(storyTwoImplementAttempts).toBe(STORY_DOCTOR_VALIDATION_FAILURE_THRESHOLD);
    expect(storyTwoDoctorAttempts).toBe(1);
    expect(result.failure.details).toMatchObject({
      storyPath: expect.any(String),
      validationRetryCount: MAX_STORY_VALIDATION_ATTEMPTS,
      retryLimit: MAX_STORY_VALIDATION_ATTEMPTS,
      validation: {
        summary: storyTwoValidationSummaries.at(-1),
        commands: [
          {
            result: storyTwoValidationResults.at(-1),
          },
        ],
      },
    });

    const state = JSON.parse(await readFile(join(result.runDir, "state.json"), "utf8")) as {
      latestStoryRouterState?: {
        route?: string;
        exhaustedReason?: string;
        reviewRetryCount?: number;
        validationRetryCount?: number;
        retryLimit?: number;
        activeStory?: { content?: string };
        latestValidation?: { summary?: string; commands?: Array<{ result?: string }> };
        source?: { reason?: string; code?: string };
      } | null;
    };
    expect(state.latestStoryRouterState).toMatchObject({
      route: "exhausted",
      exhaustedReason: "validation",
      reviewRetryCount: 0,
      validationRetryCount: MAX_STORY_VALIDATION_ATTEMPTS,
      retryLimit: MAX_STORY_VALIDATION_ATTEMPTS,
      activeStory: {
        content: expect.stringContaining("Story 002: Add exporter observability"),
      },
      latestValidation: {
        summary: storyTwoValidationSummaries.at(-1),
        commands: [
          {
            result: storyTwoValidationResults.at(-1),
          },
        ],
      },
      source: {
        reason: "failed-validation",
        code: "story_validation_exhausted",
      },
    });
  });

  it("routes blocked validation through durable story router without retrying implementation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };
    const blockedReason =
      "Validation is blocked until the widget exporter fixture can be generated deterministically.";
    const workingAgentRequests: string[] = [];

    const failed = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-blocked-validation-router-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        workingAgentRequests.push(request.outputFile);
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 002: Add exporter observability",
              "",
              "Emit observable exporter events.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("explore-story")) {
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Explored the active story.",
              relevantFiles: ["widget.txt"],
              testSeams: ["widget behavior"],
              recommendedValidationCommands: ["pnpm --filter @trailstep/create-flows test"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("write-red-tests")) {
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Wrote a focused behavioral red test.",
              redEvidence: "Focused test failed for the intended behavior.",
              changedFiles: ["widget.test.ts"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("implement-green")) {
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Implemented the green story slice.",
              changedFiles: ["widget.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("validate-story")) {
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: true,
              blockedReason,
              summary: "Validation could not run to completion.",
              commands: [
                {
                  command: "pnpm --filter @trailstep/create-flows test -- take-it-away",
                  result: "blocked: deterministic fixture generation is unavailable",
                },
              ],
              validationPassed: false,
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(failed.status).toBe("failure");
    if (failed.status !== "failure") {
      throw new Error("Expected blocked validation tracer run to fail.");
    }
    expect(failed.failure.code).toBe("story_validation_blocked");
    expect(
      workingAgentRequests.some((outputFile) => outputFile.includes("review-story-implementation")),
    ).toBe(false);

    const validateCompletedIndex = failed.events.findIndex(
      (event) => event.type === "step.completed" && event.stepId === "validate-story",
    );
    const routerStartedIndex = failed.events.findIndex(
      (event, index) =>
        event.type === "step.started" &&
        event.stepId === "story-router" &&
        index > validateCompletedIndex,
    );
    const routerFailedIndex = failed.events.findIndex(
      (event, index) =>
        event.type === "step.failed" &&
        event.stepId === "story-router" &&
        index > routerStartedIndex,
    );
    const retryImplementAfterValidationIndex = failed.events.findIndex(
      (event, index) =>
        event.type === "step.started" &&
        event.stepId === "implement-green" &&
        index > validateCompletedIndex,
    );
    const reviewAfterValidationIndex = failed.events.findIndex(
      (event, index) =>
        event.type === "step.started" &&
        event.stepId === "review-story-implementation" &&
        index > validateCompletedIndex,
    );

    expect(validateCompletedIndex).toBeGreaterThanOrEqual(0);
    expect(routerStartedIndex).toBeGreaterThan(validateCompletedIndex);
    expect(routerFailedIndex).toBeGreaterThan(routerStartedIndex);
    expect(retryImplementAfterValidationIndex).toBe(-1);
    expect(reviewAfterValidationIndex).toBe(-1);

    const failedStatePath = join(failed.runDir, "state.json");
    const failedState = JSON.parse(await readFile(failedStatePath, "utf8")) as {
      activeStory?: { path?: string; content?: string } | null;
      blockedReason?: string | null;
      latestValidationSummary?: unknown;
      latestStoryRouterState?: {
        route?: string;
        blockedPhase?: string;
        blockedReason?: string;
        reviewRetryCount?: number;
        validationRetryCount?: number;
        activeStory?: { path?: string; content?: string };
        source?: { reason?: string; blocked?: boolean; code?: string };
      } | null;
    };

    expect(failedState.blockedReason).toBe(blockedReason);
    expect(failedState.latestStoryRouterState).toMatchObject({
      route: "blocked",
      blockedPhase: "validate-story",
      blockedReason,
      reviewRetryCount: 0,
      validationRetryCount: 0,
      activeStory: {
        path: failedState.activeStory?.path,
        content: expect.stringContaining("Story 001: Build the widget exporter core"),
      },
      source: {
        reason: "failed-validation",
        blocked: true,
        code: "story_validation_blocked",
      },
    });

    const retryAgentRequests: string[] = [];
    const retried = await runWorkflow({
      workflow: takeItAway,
      retry: { runDir: failed.runDir, kind: "manual" },
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        retryAgentRequests.push(request.outputFile);
        throw new Error(`Retry should not dispatch a new agent prompt: ${request.outputFile}`);
      },
    });

    expect(retried.status).toBe("failure");
    if (retried.status !== "failure") {
      throw new Error("Expected blocked validation retry to fail deterministically.");
    }
    expect(retried.failure).toMatchObject({
      code: "story_validation_blocked",
      message: blockedReason,
    });

    const retryStartedIndex = retried.events.findIndex(
      (event) => event.type === "workflow.retryStarted",
    );
    const retryRouterStartedIndex = retried.events.findIndex(
      (event, index) =>
        event.type === "step.started" &&
        event.stepId === "story-router" &&
        index > retryStartedIndex,
    );
    const retryRouterFailedIndex = retried.events.findIndex(
      (event, index) =>
        event.type === "step.failed" &&
        event.stepId === "story-router" &&
        index > retryRouterStartedIndex,
    );
    expect(retryStartedIndex).toBeGreaterThanOrEqual(0);
    expect(retryRouterStartedIndex).toBeGreaterThan(retryStartedIndex);
    expect(retryRouterFailedIndex).toBeGreaterThan(retryRouterStartedIndex);
    expect(
      retried.events.some(
        (event, index) =>
          index > retryStartedIndex &&
          event.type === "step.started" &&
          typeof event.stepId === "string" &&
          [
            "explore-story",
            "write-red-tests",
            "implement-green",
            "validate-story",
            "review-story-implementation",
          ].includes(event.stepId),
      ),
    ).toBe(false);
    expect(retryAgentRequests).toEqual([]);
  });

  it("routes only scoped active-story implementer context into the explore prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };

    const explorePrompts: string[] = [];
    const implementRequests: string[] = [];

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-scoped-context-explore-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "Overview text for planners only.",
              "",
              "<context>",
              "",
              "GLOBAL_CONTEXT_TOKEN",
              "",
              "</context>",
              "",
              "<context>",
              "audience: implementer",
              "stories: Story 001",
              "phases: explore-story",
              "",
              "STORY_001_EXPLORE_CONTEXT_TOKEN",
              "",
              "</context>",
              "",
              "<context>",
              "audience: implementer",
              "stories: Story 002",
              "phases: explore-story",
              "",
              "STORY_002_CONTEXT_TOKEN",
              "",
              "</context>",
              "",
              "<context>",
              "audience: reviewer",
              "stories: Story 001",
              "phases: explore-story",
              "",
              "REVIEWER_ONLY_CONTEXT_TOKEN",
              "",
              "</context>",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "This active story mentions inline <context> marker prose as ordinary text.",
              "INLINE_CONTEXT_MARKER_STORY_TEXT",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 002: Add exporter observability",
              "",
              "Emit observable exporter events.",
              "STORY_002_BODY_TOKEN",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("explore-story")) {
          explorePrompts.push(await readFile(request.promptFile, "utf8"));
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Explored the active story with scoped context.",
              relevantFiles: ["widget.txt"],
              testSeams: ["widget exporter behavior"],
              recommendedValidationCommands: ["pnpm --filter @trailstep/create-flows test"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }

        if (request.outputFile.includes("implement-green")) {
          implementRequests.push(request.outputFile);
          return { exitCode: 1 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected the run to stop at the controlled fake implementation phase.");
    }
    expect(result.failure.code).not.toBe("unbalanced_story_context");
    expect(implementRequests).toHaveLength(1);
    expect(explorePrompts).toHaveLength(1);

    const prompt = explorePrompts[0];
    expect(prompt).toContain("Story 001: Build the widget exporter core");
    expect(prompt).toContain("STORY_001_EXPLORE_CONTEXT_TOKEN");
    expect(prompt).toContain("INLINE_CONTEXT_MARKER_STORY_TEXT");
    expect(prompt).not.toContain("Story 002: Add exporter observability");
    expect(prompt).not.toContain("STORY_002_BODY_TOKEN");
    expect(prompt).not.toContain("STORY_002_CONTEXT_TOKEN");
    expect(prompt).not.toContain("REVIEWER_ONLY_CONTEXT_TOKEN");
    expect(prompt).not.toContain("GLOBAL_CONTEXT_TOKEN");

    const state = JSON.parse(await readFile(join(result.runDir, "state.json"), "utf8")) as {
      activeStory?: { content?: string } | null;
    };

    expect(state.activeStory?.content?.trimStart().startsWith("## Story 001:")).toBe(true);
  });

  it("does not prepend unscoped context blocks to split stories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-context-split-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "Overview that should stay outside implementer stories.",
              "",
              "<context>",
              "",
              "Shared architecture context: use the WidgetPort seam.",
              "",
              "</context>",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 002: Add exporter observability",
              "",
              "Emit observable exporter events.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("implement-green")) {
          return { exitCode: 1 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("failure");

    const state = JSON.parse(await readFile(join(result.runDir, "state.json"), "utf8")) as {
      activeStory?: { content?: string } | null;
      storyQueue?: Array<{ content?: string }>;
    };

    expect(state.activeStory?.content?.trimStart().startsWith("## Story 001:")).toBe(true);
    expect(state.activeStory?.content).not.toContain("Shared architecture context");
    expect(state.activeStory?.content).not.toContain("Overview that should stay outside");
    expect(state.storyQueue?.[0]?.content?.trimStart().startsWith("## Story 002:")).toBe(true);
    expect(state.storyQueue?.[0]?.content).not.toContain("Shared architecture context");
  });

  it("ignores inline context marker mentions when splitting implementation stories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-inline-context-mention-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "Overview that should stay outside implementer stories.",
              "",
              "<context>",
              "",
              "Shared architecture context: use the WidgetPort seam.",
              "",
              "</context>",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "This story may mention the literal `<context>` marker in prose without opening a block.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("implement-green")) {
          return { exitCode: 1 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected the run to stop at implement-green after successful splitting.");
    }
    expect(result.failure.code).not.toBe("unbalanced_story_context");

    const state = JSON.parse(await readFile(join(result.runDir, "state.json"), "utf8")) as {
      activeStory?: { content?: string } | null;
    };

    expect(state.activeStory?.content).not.toContain("Shared architecture context");
    expect(state.activeStory?.content).toContain("literal `<context>` marker in prose");
  });

  it("review prompt excludes full diff hunks and provides local inspection metadata", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "widget.txt"), "initial widget\n", "utf8");
    await git(cwd, ["add", "widget.txt", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial widget"]);
    const baseline = await git(cwd, ["rev-parse", "HEAD"]);

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };

    const reviewerPrompts: string[] = [];

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-story-baseline-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "Overview of the widget exporter plan.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("implement-green")) {
          await writeFile(
            join(cwd, "widget.txt"),
            "initial widget\nCOMMITTED_DIFF_PAYLOAD_TOKEN\n",
            "utf8",
          );
          await git(cwd, ["add", "widget.txt"]);
          await git(cwd, ["commit", "-m", "implement committed story slice"]);
          await writeFile(
            join(cwd, "widget.txt"),
            "initial widget\nCOMMITTED_DIFF_PAYLOAD_TOKEN\nUNCOMMITTED_DIFF_PAYLOAD_TOKEN\n",
            "utf8",
          );
          await writeFile(join(cwd, "new-widget.txt"), "UNTRACKED_DIFF_PAYLOAD_TOKEN\n", "utf8");
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Implemented committed, uncommitted, and untracked story changes.",
              changedFiles: ["widget.txt", "new-widget.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-story-implementation")) {
          reviewerPrompts.push(await readFile(request.promptFile, "utf8"));
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("success");
    expect(reviewerPrompts).toHaveLength(1);
    const prompt = reviewerPrompts[0];
    expect(prompt).toContain("Story 001: Build the widget exporter core");
    expect(prompt).toContain("Implemented committed, uncommitted, and untracked story changes.");
    expect(prompt).toContain(`Recorded story start commit: ${baseline}`);
    expect(prompt).toContain("- widget.txt");
    expect(prompt).toContain("- new-widget.txt");
    expect(prompt).toContain("widget.txt | 1 +");
    expect(prompt).toContain("git status --short");
    expect(prompt).toContain(`git diff ${baseline}..HEAD`);
    expect(prompt).toContain("git diff");
    expect(prompt).not.toContain("COMMITTED_DIFF_PAYLOAD_TOKEN");
    expect(prompt).not.toContain("UNCOMMITTED_DIFF_PAYLOAD_TOKEN");
    expect(prompt).not.toContain("UNTRACKED_DIFF_PAYLOAD_TOKEN");
    expect(prompt).not.toContain("@@");
  });

  it("review prompt for a later story excludes prior story summaries after transition", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await writeFile(join(cwd, "observability.txt"), "", "utf8");
    await git(cwd, ["add", "README.md", "observability.txt", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);
    process.env.TRAILSTEP_STORY_COMMIT_MODE = "enabled";

    const priorStoryTokens = [
      "PRIOR_STORY_EXPLORATION_TOKEN",
      "PRIOR_STORY_RED_TOKEN",
      "PRIOR_STORY_IMPLEMENTATION_TOKEN",
      "PRIOR_STORY_VALIDATION_TOKEN",
      "PRIOR_STORY_REVIEW_TOKEN",
    ] as const;
    const storyTwoExplorationToken = "STORY_002_EXPLORATION_TOKEN";
    const storyTwoRedToken = "STORY_002_RED_TOKEN";
    const storyTwoImplementationToken = "STORY_002_IMPLEMENTATION_TOKEN";
    const storyTwoValidationToken = "STORY_002_VALIDATION_TOKEN";

    const passingImplementationDocReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };
    const passingStoryReview = (summary: string) => ({
      score: 5,
      summary,
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    });
    const storyTwoReviewPrompts: string[] = [];
    let storyTwoBaseline: string | undefined;

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-later-story-review-prompt-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 002: Add exporter observability",
              "",
              "Emit observable exporter events.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(
            request.outputFile,
            JSON.stringify(passingImplementationDocReview),
            "utf8",
          );
          return { exitCode: 0 };
        }

        const prompt = await readFile(request.promptFile, "utf8");
        const storyLabel = prompt.includes("Story 002: Add exporter observability")
          ? "Story 002"
          : "Story 001";

        if (request.outputFile.includes("explore-story")) {
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: storyLabel === "Story 001" ? priorStoryTokens[0] : storyTwoExplorationToken,
              relevantFiles: [storyLabel === "Story 001" ? "widget.txt" : "observability.txt"],
              testSeams: [`${storyLabel} behavior`],
              recommendedValidationCommands: ["pnpm --filter @trailstep/create-flows test"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("write-red-tests")) {
          const redToken = storyLabel === "Story 001" ? priorStoryTokens[1] : storyTwoRedToken;
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: redToken,
              redEvidence: `${redToken} failed for the intended reason.`,
              changedFiles: [`${storyLabel}.test.ts`],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("implement-green")) {
          if (storyLabel === "Story 001") {
            await writeFile(join(cwd, "widget.txt"), `${priorStoryTokens[2]}\n`, "utf8");
            await writeFile(
              request.outputFile,
              JSON.stringify({
                blocked: false,
                summary: priorStoryTokens[2],
                changedFiles: ["widget.txt"],
              }),
              "utf8",
            );
            return { exitCode: 0 };
          }

          storyTwoBaseline = await git(cwd, ["rev-parse", "HEAD"]);
          await writeFile(
            join(cwd, "observability.txt"),
            `${storyTwoImplementationToken}\n`,
            "utf8",
          );
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: storyTwoImplementationToken,
              changedFiles: ["observability.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("validate-story")) {
          const validationToken =
            storyLabel === "Story 001" ? priorStoryTokens[3] : storyTwoValidationToken;
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: validationToken,
              commands: [
                {
                  command: "pnpm --filter @trailstep/create-flows test",
                  result: `${validationToken} passed`,
                },
              ],
              validationPassed: true,
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-story-implementation")) {
          if (storyLabel === "Story 002") {
            storyTwoReviewPrompts.push(prompt);
          }
          await writeFile(
            request.outputFile,
            JSON.stringify(
              passingStoryReview(
                storyLabel === "Story 001" ? priorStoryTokens[4] : "Story 002 review passes.",
              ),
            ),
            "utf8",
          );
          return { exitCode: 0 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("success");
    expect(storyTwoReviewPrompts).toHaveLength(1);
    const prompt = storyTwoReviewPrompts[0] ?? "";
    expect(prompt).toContain("Story 002: Add exporter observability");
    expect(prompt).toContain(storyTwoExplorationToken);
    expect(prompt).toContain(storyTwoRedToken);
    expect(prompt).toContain(`${storyTwoRedToken} failed for the intended reason.`);
    expect(prompt).toContain(storyTwoImplementationToken);
    expect(prompt).toContain(storyTwoValidationToken);
    expect(prompt).toContain("Story review git metadata");
    expect(prompt).toContain(`Recorded story start commit: ${storyTwoBaseline}`);
    expect(prompt).toContain("Changed files:");
    expect(prompt).toContain("Uncommitted changed files:");
    expect(prompt).toContain("Committed diffstat");
    expect(prompt).toContain("Uncommitted diffstat");
    expect(prompt).toContain("observability.txt | 1 +");
    expect(prompt).toContain("git status --short");
    expect(prompt).not.toContain("Story 001: Build the widget exporter core");
    for (const priorStoryToken of priorStoryTokens) {
      expect(prompt).not.toContain(priorStoryToken);
    }
    expect(prompt).not.toContain("diff --git");
    expect(prompt).not.toContain("@@");
  }, 10_000);

  it("blocks before the next story prompt when auto-commit is disabled and reviewed changes are dirty", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };

    const implementedStoryPrompts: string[] = [];
    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-dirty-boundary-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 002: Add exporter observability",
              "",
              "Emit observable exporter events.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("implement-green")) {
          const prompt = await readFile(request.promptFile, "utf8");
          implementedStoryPrompts.push(prompt);
          await writeFile(join(cwd, "widget.txt"), "exported widget\n", "utf8");
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Implemented widget exporter core in widget.txt.",
              changedFiles: ["widget.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-story-implementation")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected dirty story boundary to block the next story.");
    }
    expect(result.failure.code).toBe("story_boundary_dirty_without_auto_commit");
    expect(result.failure.message).toContain(
      "Commit, stash, or otherwise restore a clean story boundary",
    );
    expect(implementedStoryPrompts).toHaveLength(1);
    expect(implementedStoryPrompts[0]).toContain("Story 001");
    expect(implementedStoryPrompts[0]).not.toContain("Story 002");

    const state = JSON.parse(await readFile(join(result.runDir, "state.json"), "utf8")) as {
      activeStory?: { content?: string } | null;
      completedStories?: string[];
      storyQueue?: Array<{ content?: string }>;
    };
    expect(state.completedStories).toEqual([]);
    expect(state.activeStory?.content).toContain("Story 001: Build the widget exporter core");
    expect(state.storyQueue).toHaveLength(1);
    expect(state.storyQueue?.[0]?.content).toContain("Story 002: Add exporter observability");
  });

  it("commits each passing reviewed story when story commit mode is enabled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);

    const previousCommitMode = process.env.TRAILSTEP_STORY_COMMIT_MODE;
    process.env.TRAILSTEP_STORY_COMMIT_MODE = "enabled";

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };

    try {
      const result = await runWorkflow({
        workflow: takeItAway,
        input: { conversation: "We want a widget exporter." },
        runName: "take-it-away-autocommit-run",
        cwd,
        trailstepConfig: {
          version: 1,
          customProviders: { worker: { binary: "worker-agent" } },
          agents: {
            small: [{ provider: "worker" }],
            medium: [{ provider: "worker" }],
            large: [{ provider: "worker" }],
          },
        },
        workingAgentProcessRunner: async (request) => {
          const splitPhaseResult = await handleNonGreenStoryPhase(request);
          if (splitPhaseResult) {
            return splitPhaseResult;
          }
          if (request.outputFile.includes("create-feature-doc")) {
            await writeFile(
              request.outputFile,
              "# Feature Doc\n\nA widget exporter feature.",
              "utf8",
            );
            return { exitCode: 0 };
          }

          if (request.outputFile.includes("create-or-improve-implementation-doc")) {
            await writeFile(
              request.outputFile,
              [
                "# Implementation Doc",
                "",
                "Overview of the widget exporter plan.",
                "",
                "<!-- trailstep-story-boundary -->",
                "",
                "## Story 001: Build the widget exporter core",
                "",
                "Implement the core widget exporter behavior.",
              ].join("\n"),
              "utf8",
            );
            return { exitCode: 0 };
          }

          if (request.outputFile.includes("review-implementation-doc")) {
            await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
            return { exitCode: 0 };
          }

          if (request.outputFile.includes("implement-green")) {
            await writeFile(join(cwd, "widget.txt"), "exported widget\n", "utf8");
            await writeFile(
              request.outputFile,
              JSON.stringify({
                blocked: false,
                summary: "Implemented widget exporter core in widget.txt.",
                changedFiles: ["widget.txt"],
              }),
              "utf8",
            );
            return { exitCode: 0 };
          }

          if (request.outputFile.includes("review-story-implementation")) {
            await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
            return { exitCode: 0 };
          }

          throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
        },
      });

      expect(result.status).toBe("success");
      const log = await git(cwd, ["log", "--oneline", "--max-count=2"]);
      expect(log).toContain("trailstep: Story 001: Build the widget exporter core");
      expect(await git(cwd, ["status", "--short"])).toBe("");
    } finally {
      if (previousCommitMode === undefined) {
        delete process.env.TRAILSTEP_STORY_COMMIT_MODE;
      } else {
        process.env.TRAILSTEP_STORY_COMMIT_MODE = previousCommitMode;
      }
    }
  });

  it("retry of an interrupted story does not dispatch stale legacy implementation prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };

    const trailstepConfig = {
      version: 1 as const,
      customProviders: { worker: { binary: "worker-agent" } },
      agents: {
        small: [{ provider: "worker" }],
        medium: [{ provider: "worker" }],
        large: [{ provider: "worker" }],
      },
    };

    const failed = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-retry-active-story-run",
      cwd,
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "Overview of the widget exporter plan.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 002: Add exporter observability",
              "",
              "Emit observable exporter events.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("implement-green")) {
          return { exitCode: 1 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(failed.status).toBe("failure");

    const implementedStoryPrompts: string[] = [];
    const retried = await runWorkflow({
      workflow: takeItAway,
      retry: { runDir: failed.runDir, kind: "manual" },
      trailstepConfig,
      workingAgentProcessRunner: async (request) => {
        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }
        if (request.outputFile.includes("implement-green")) {
          const prompt = await readFile(request.promptFile, "utf8");
          implementedStoryPrompts.push(prompt);
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Implemented the active widget exporter story with passing tests.",
              changedFiles: ["widget.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-story-implementation")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        throw new Error(`Unexpected retry working-agent request: ${request.outputFile}`);
      },
    });

    if (retried.status === "success") {
      expect(implementedStoryPrompts).toHaveLength(1);
      expect(implementedStoryPrompts[0]).toContain("Story 001: Build the widget exporter core");
      expect(implementedStoryPrompts[0]).not.toContain("Story 002: Add exporter observability");
    } else {
      expect(retried.failure.message).toContain(
        "Completed history continues after the current workflow reaches done.",
      );
      expect(implementedStoryPrompts).toHaveLength(0);
    }
  });

  it("wires straight into feature-implementation's create-feature-doc with the supplied conversation and completes the full reviewed pipeline", async () => {
    expect(createFeatureDocStep).toBeTypeOf("function");

    const cwd = await mkdtemp(join(tmpdir(), "trailstep-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);

    const passingReview = {
      score: 5,
      summary: "Meets the methodology.",
      methodologyRatings: {
        tdd: 5,
        verticalSlicing: 5,
        tracerBullet: 5,
        dependencies: 5,
        architecture: 5,
      },
      requiredImprovements: [],
    };

    const result = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-tracer-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
          small: [{ provider: "worker" }],
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
      },
      workingAgentProcessRunner: async (request) => {
        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }
        if (request.outputFile.includes("create-feature-doc")) {
          await writeFile(
            request.outputFile,
            "# Feature Doc\n\nA widget exporter feature.",
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("create-or-improve-implementation-doc")) {
          await writeFile(
            request.outputFile,
            [
              "# Implementation Doc",
              "",
              "Overview of the widget exporter plan.",
              "",
              "<!-- trailstep-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-implementation-doc")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("implement-green")) {
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Implemented the widget exporter core with passing tests.",
              changedFiles: ["widget.txt"],
            }),
            "utf8",
          );
          return { exitCode: 0 };
        }

        if (request.outputFile.includes("review-story-implementation")) {
          await writeFile(request.outputFile, JSON.stringify(passingReview), "utf8");
          return { exitCode: 0 };
        }

        throw new Error(`Unexpected working-agent request: ${request.outputFile}`);
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(result.output).toMatchObject({
      status: "implemented",
      storyCount: 1,
      completedStories: ["Story 001: Build the widget exporter core"],
    });
  });
});
