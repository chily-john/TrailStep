import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWorkflow } from "@trailstep/core";
import { describe, expect, it } from "vitest";

import { grillItAway } from "./workflow.js";

describe("grill-it-away", () => {
  it("fails when the completion payload does not match the conversation schema", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-grill-it-away-invalid-"));

    const result = await runWorkflow({
      workflow: grillItAway,
      input: {},
      runName: "grill-it-away-invalid-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["{{promptFile}}"] },
        },
        agents: {
          medium: [{ provider: "terminalAgent" }],
        },
      },
      processRunner: async (call) => {
        const interactiveFile = call.env?.STEPKIT_INTERACTIVE_FILE;
        const protocol = JSON.parse(await readFile(interactiveFile ?? "", "utf8"));
        await writeFile(protocol.outputFile, `${JSON.stringify({}, null, 2)}\n`, "utf8");
        await writeFile(
          interactiveFile ?? "",
          `${JSON.stringify({ ...protocol, status: "completed" }, null, 2)}\n`,
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("failure");
  });

  it("once grilling completes, grill-it-away proceeds into feature-implementation's create-feature-doc with the transcript, and runs the full reviewed pipeline through to done", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-grill-it-away-pipeline-"));
    const transcript = "User: I want a widget.\nAgent: Tell me more...\nUser: ...";

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

    let createFeatureDocPrompt: string | undefined;

    const result = await runWorkflow({
      workflow: grillItAway,
      input: {},
      runName: "grill-it-away-pipeline-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["{{promptFile}}"] },
          worker: { binary: "worker-agent" },
        },
        agents: {
          medium: [{ provider: "worker" }],
          large: [{ provider: "worker" }],
        },
        workflows: {
          "grill-it-away": {
            agents: {
              grillingAgent: [{ provider: "terminalAgent" }],
            },
          },
        },
      },
      processRunner: async (call) => {
        const interactiveFile = call.env?.STEPKIT_INTERACTIVE_FILE;
        const protocol = JSON.parse(await readFile(interactiveFile ?? "", "utf8"));
        await writeFile(
          protocol.outputFile,
          `${JSON.stringify({ conversation: transcript }, null, 2)}\n`,
          "utf8",
        );
        await writeFile(
          interactiveFile ?? "",
          `${JSON.stringify({ ...protocol, status: "completed" }, null, 2)}\n`,
          "utf8",
        );
        return { exitCode: 0 };
      },
      workingAgentProcessRunner: async (request) => {
        if (request.outputFile.includes("create-feature-doc")) {
          createFeatureDocPrompt = await readFile(request.promptFile, "utf8");
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

    const grillStartedIndex = result.events.findIndex(
      (event) => event.type === "step.started" && event.stepId === "grill",
    );
    const createFeatureDocStartedIndex = result.events.findIndex(
      (event) => event.type === "step.started" && event.stepId === "create-feature-doc",
    );

    expect(grillStartedIndex).toBeGreaterThanOrEqual(0);
    expect(createFeatureDocStartedIndex).toBeGreaterThan(grillStartedIndex);

    expect(createFeatureDocPrompt).toContain(transcript);
  });
});
