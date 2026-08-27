import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { runWorkflow } from "@trailstep/core";
import { describe, expect, it } from "vitest";

import { createFeatureDocStep } from "../feature-implementation/create-feature-doc/step.js";
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
