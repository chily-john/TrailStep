import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWorkflow } from "@stepkit/core";
import { describe, expect, it } from "vitest";

import { createFeatureDocStep } from "../feature-implementation/create-feature-doc/step.js";
import { takeItAway } from "./workflow.js";

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
