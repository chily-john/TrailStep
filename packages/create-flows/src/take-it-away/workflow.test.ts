import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { runWorkflow } from "@stepkit/core";
import { describe, expect, it } from "vitest";

import { createFeatureDocStep } from "../feature-implementation/create-feature-doc/step.js";
import { takeItAway } from "./workflow.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout.trimEnd();
}

describe("take-it-away", () => {
  it("keeps the selected story durably active when implementation is interrupted before review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-take-it-away-"));

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
      stepkitConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
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
              "Overview of the widget exporter plan.",
              "",
              "<!-- stepkit-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "<!-- stepkit-story-boundary -->",
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

        if (request.outputFile.includes("implement-story")) {
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

  it("review prompt includes committed and uncommitted story changes from the story baseline", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-take-it-away-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "stepkit@example.test"]);
    await git(cwd, ["config", "user.name", "StepKit Test"]);
    await writeFile(join(cwd, "widget.txt"), "initial widget\n", "utf8");
    await git(cwd, ["add", "widget.txt"]);
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
      stepkitConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
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
              "Overview of the widget exporter plan.",
              "",
              "<!-- stepkit-story-boundary -->",
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

        if (request.outputFile.includes("implement-story")) {
          await writeFile(
            join(cwd, "widget.txt"),
            "initial widget\ncommitted story change\n",
            "utf8",
          );
          await git(cwd, ["add", "widget.txt"]);
          await git(cwd, ["commit", "-m", "implement committed story slice"]);
          await writeFile(
            join(cwd, "widget.txt"),
            "initial widget\ncommitted story change\nuncommitted story change\n",
            "utf8",
          );
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Implemented committed and uncommitted story changes.",
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
    expect(reviewerPrompts[0]).toContain(baseline);
    expect(reviewerPrompts[0]).toContain(`git diff ${baseline}..HEAD`);
    expect(reviewerPrompts[0]).toContain("committed story change");
    expect(reviewerPrompts[0]).toContain("uncommitted story change");
  });

  it("retry of an interrupted story implements the active story before advancing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-take-it-away-"));

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

    const stepkitConfig = {
      version: 1 as const,
      customProviders: { worker: { binary: "worker-agent" } },
      agents: {
        medium: [{ provider: "worker" }],
        large: [{ provider: "worker" }],
      },
    };

    const failed = await runWorkflow({
      workflow: takeItAway,
      input: { conversation: "We want a widget exporter." },
      runName: "take-it-away-retry-active-story-run",
      cwd,
      stepkitConfig,
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
              "Overview of the widget exporter plan.",
              "",
              "<!-- stepkit-story-boundary -->",
              "",
              "## Story 001: Build the widget exporter core",
              "",
              "Implement the core widget exporter behavior.",
              "",
              "<!-- stepkit-story-boundary -->",
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

        if (request.outputFile.includes("implement-story")) {
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
      stepkitConfig,
      workingAgentProcessRunner: async (request) => {
        if (request.outputFile.includes("implement-story")) {
          const prompt = await readFile(request.promptFile, "utf8");
          implementedStoryPrompts.push(prompt);
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Implemented the active widget exporter story with passing tests.",
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

    expect(retried.status).toBe("success");
    if (retried.status !== "success") {
      throw new Error(retried.failure.message);
    }

    expect(implementedStoryPrompts[0]).toContain("Story 001");
    expect(implementedStoryPrompts[1]).toContain("Story 002");
    expect(retried.output.completedStories).toEqual([
      "Story 001: Build the widget exporter core",
      "Story 002: Add exporter observability",
    ]);
  });

  it("wires straight into feature-implementation's create-feature-doc with the supplied conversation and completes the full reviewed pipeline", async () => {
    expect(createFeatureDocStep).toBeTypeOf("function");

    const cwd = await mkdtemp(join(tmpdir(), "stepkit-take-it-away-"));

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
      stepkitConfig: {
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: {
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
              "Overview of the widget exporter plan.",
              "",
              "<!-- stepkit-story-boundary -->",
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

        if (request.outputFile.includes("implement-story")) {
          await writeFile(
            request.outputFile,
            JSON.stringify({
              blocked: false,
              summary: "Implemented the widget exporter core with passing tests.",
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
