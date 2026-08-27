import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { runWorkflow } from "@trailstep/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { grillItAway } from "./workflow.js";

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

describe("grill-it-away", () => {
  it("fails when the completion payload does not match the conversation schema", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-grill-it-away-invalid-"));

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
        const interactiveFile = call.env?.TRAILSTEP_INTERACTIVE_FILE;
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
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-grill-it-away-pipeline-"));
    await git(cwd, ["init"]);
    await git(cwd, ["config", "user.email", "trailstep@example.test"]);
    await git(cwd, ["config", "user.name", "TrailStep Test"]);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
    await writeFile(join(cwd, "README.md"), "# test repo\n", "utf8");
    await git(cwd, ["add", "README.md", ".trailstep/.gitignore"]);
    await git(cwd, ["commit", "-m", "initial commit"]);
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
          small: [{ provider: "worker" }],
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
        const interactiveFile = call.env?.TRAILSTEP_INTERACTIVE_FILE;
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
        const splitPhaseResult = await handleNonGreenStoryPhase(request);
        if (splitPhaseResult) {
          return splitPhaseResult;
        }

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
